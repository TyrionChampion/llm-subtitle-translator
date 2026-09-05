// Content script: observes native subtitles on the page, sends them to the
// background service worker for translation, and overlays translated text.
//
// Detection strategy (in order):
//   1. Platform-specific selectors (fast, precise when they match).
//   2. Generic fallback: find <video>, then any descendant of its player
//      container whose text is rendered near the bottom of the video rect.
//      This survives Disney+ / Prime classname changes across regions.
//   3. Shadow DOM traversal is performed at every step.

(() => {
  if (window.__llmSubtitleTranslatorLoaded) return;
  window.__llmSubtitleTranslatorLoaded = true;

  const HOST = location.hostname;
  const DEBUG_PREFIX = "[subtitle-translator]";

  const PLATFORMS = [
    {
      match: /(^|\.)netflix\.com$/,
      name: "netflix",
      containerSelectors: [".player-timedtext"],
    },
    {
      match: /(^|\.)(disneyplus|hotstar|starplus)\.com$/,
      name: "disneyplus",
      containerSelectors: [
        ".dss-subtitle-renderer-wrapper",
        ".dss-subtitle-renderer-cue-window",
        ".dss-subtitle-renderer-cue-container",
        ".btm-media-client-subtitle-window",
        "[class*='subtitle-renderer']",
        "[class*='SubtitleRenderer']",
      ],
    },
    {
      match: /(^|\.)(primevideo|amazon)\.com$/,
      name: "prime",
      containerSelectors: [
        ".atvwebplayersdk-captions-overlay",
        "[class*='captions-overlay']",
        "[class*='atvwebplayersdk-captions']",
      ],
    },
    {
      match: /(^|\.)youtube\.com$/,
      name: "youtube",
      containerSelectors: [".ytp-caption-window-container"],
    },
    {
      match: /(^|\.)(hbomax|max)\.com$/,
      name: "max",
      containerSelectors: [
        "[data-testid='player-subtitles']",
        "[class*='subtitle']",
      ],
    },
    {
      match: /(^|\.)(appletv\.com|tv\.apple\.com)$/,
      name: "appletv",
      containerSelectors: [
        "[class*='subtitle']",
        "[class*='caption']",
      ],
    },
    {
      // TVer uses video.js for most programs; subtitles land in
      // .vjs-text-track-display. Some shows use forced in-video captions
      // (no DOM) — those won't be translatable.
      match: /(^|\.)tver\.jp$/,
      name: "tver",
      containerSelectors: [
        ".vjs-text-track-display",
        ".vjs-text-track-cue",
        ".vjs-text-track-cue-text",
      ],
    },
  ];

  const platform = PLATFORMS.find((p) => p.match.test(HOST)) || {
    name: "generic",
    containerSelectors: [],
  };

  // Only activate on actual player pages. Netflix browse pages autoplay small
  // billboard previews; translating those is noisy and wastes API calls.
  function isPlayerPage() {
    const path = location.pathname;
    switch (platform.name) {
      case "netflix":
        return /\/watch\/\d+/.test(path);
      case "disneyplus":
        // Disney+ / Hotstar / StarPlus player routes
        return /\/(video|play|movies\/[^/]+\/[^/]+)\//.test(path) ||
          /\/video\//.test(path);
      case "youtube":
        return path === "/watch" || path.startsWith("/embed/");
      case "prime":
        // Prime Video's full-screen player uses these paths; browse pages
        // may autoplay small trailer loops on detail, so we require detail
        // + a known player marker.
        return /\/(detail|gp\/video\/detail|video\/player)\//.test(path);
      case "max":
        return /\/(video\/watch|player)\//.test(path);
      case "appletv":
        return /\/(movie|show|episode|watch|sporting-event)\//.test(path) ||
          !!findPlaybackDialog(getMainVideo());
      case "tver":
        return /\/(episodes|live|lives|series)\//.test(path);
      default:
        return true;
    }
  }

  // Unconditional load banner so the user can verify injection from devtools.
  // Bump this when shipping a fix so the user can confirm the new code landed.
  const BUILD = "2026-09-05-appletv-native-tracks";
  console.log(
    `${DEBUG_PREFIX} content script loaded (build ${BUILD}) on ${HOST} ` +
      `(platform=${platform.name}, frame=${window.top === window ? "top" : "sub"})`
  );

  // Inject the MAIN-world subtitle capture script as early as possible so it
  // can patch fetch/XHR before the player issues subtitle requests.
  (function injectCaptureScript() {
    if (platform.name === "appletv") return; // Native TextTracks are the source of truth.
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn(DEBUG_PREFIX, "failed to inject capture script:", e);
    }
  })();

  // -------------- state --------------
  let settings = null;
  let overlay = null;
  let currentOriginal = "";
  let currentTranslated = "";
  const cache = new Map();
  const history = [];
  const HISTORY_MAX = 12;
  const pending = new Map();
  let lastTranslationAt = 0;
  const MIN_INTERVAL_MS = 150;
  let lastLoggedText = null;
  let cueSetAt = 0;
  const STALE_CUE_MS = 10000; // force-clear if the same cue persists this long

  // --- Pre-translation library (populated by inject.js via postMessage) ---
  // cueLibrary: unique key ("start|end|text") -> { start, end, text, translation, translating }
  const cueLibrary = new Map();
  let cueList = []; // sorted by start time
  let lastCueCaptureAt = 0;
  let sessionGeneration = 0;
  let selectedTrackLanguage = "";
  let lastNativeScanAt = 0;

  function log(...args) {
    if (settings?.debug) console.log(DEBUG_PREFIX, ...args);
  }

  // Coarse language detection by script range. CJK-only text (no hiragana /
  // katakana / hangul) is ambiguous because Japanese and Chinese share the
  // kanji range — short lines like "東京" or "殺人事件" can belong to either.
  // Strategy: remember the language the current session has been confidently
  // identified as (via kana, hangul, Cyrillic, Latin, or an xml:lang from a
  // captured subtitle file), and fall back to it for ambiguous lines.
  const TRADITIONAL_MARKERS = /[繁體國學愛們會個時這萬對發頭來說麼這個話請過點時當開關長無師寫聽車馬龍樓嗎見讀書現實內對應動進經濟經過機構參與飛錢麵]/;
  let sessionLanguage = null; // reset on navigation

  function setSessionLanguage(lang) {
    if (lang && sessionLanguage !== lang) {
      sessionLanguage = lang;
      console.log(DEBUG_PREFIX, "session language:", lang);
    }
  }

  function detectLang(text) {
    if (!text) return "other";
    // Strong signals — these uniquely identify a language.
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
      setSessionLanguage("日本語");
      return "日本語";
    }
    if (/[\uAC00-\uD7AF]/.test(text)) {
      setSessionLanguage("한국어");
      return "한국어";
    }
    if (/[\u0400-\u04FF]/.test(text)) {
      setSessionLanguage("Русский");
      return "Русский";
    }
    if (/[\u0370-\u03FF]/.test(text)) {
      setSessionLanguage("Ελληνικά");
      return "Ελληνικά";
    }
    // CJK-only — ambiguous between Chinese and Japanese.
    if (/[\u4E00-\u9FFF]/.test(text)) {
      // If the session has already been firmly identified as Japanese /
      // Korean (via an earlier line or the subtitle file's xml:lang), trust
      // that over a naive Chinese classification.
      if (sessionLanguage === "日本語") return "日本語";
      if (sessionLanguage === "한국어") return "한국어";
      return TRADITIONAL_MARKERS.test(text) ? "繁體中文" : "简体中文";
    }
    if (/[A-Za-z]/.test(text)) {
      // Latin is ambiguous between English / Spanish / French / German etc.;
      // we only set session when no prior stronger signal exists.
      if (!sessionLanguage) setSessionLanguage("English");
      return "English";
    }
    return "other";
  }

  // Convert a BCP-47 / ISO code (en, ja, ko, zh-TW, zh-CN, ru, el, etc.) into
  // the display names used in our skip-list UI.
  function langCodeToDisplay(code) {
    if (!code) return null;
    const c = code.toLowerCase();
    if (c.startsWith("ja")) return "日本語";
    if (c.startsWith("ko")) return "한국어";
    if (c.startsWith("ru")) return "Русский";
    if (c.startsWith("el")) return "Ελληνικά";
    if (
      c.startsWith("zh-tw") ||
      c.startsWith("zh-hk") ||
      c.startsWith("zh-hant")
    )
      return "繁體中文";
    if (c.startsWith("zh")) return "简体中文";
    if (c.startsWith("en")) return "English";
    return null;
  }

  function shouldSkipTranslation(text) {
    const list = settings?.skipLanguages || [];
    if (!list.length) return false;
    return list.includes(detectLang(text));
  }

  // -------------- overlay --------------
  function fullscreenTarget() {
    // When the page is in fullscreen, the browser only paints the fullscreen
    // element and its descendants. An overlay attached to <html> becomes
    // invisible until fullscreen exits. Move it inside the fullscreen root.
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
  }

  function findPlaybackDialog(video) {
    for (let node = video; node; node = node.parentElement || node.getRootNode?.()?.host) {
      if (node.tagName === "DIALOG" && node.open) return node;
    }
    return null;
  }

  function overlayTarget() {
    // showModal() puts Apple's playback dialog in the browser's top layer.
    // No z-index on a sibling under <html> can paint above that dialog.
    return findPlaybackDialog(getMainVideo()) || fullscreenTarget() || document.documentElement;
  }

  function ensureOverlay() {
    const target = overlayTarget();
    if (
      overlay &&
      overlay.isConnected &&
      overlay.parentElement === target
    ) {
      return overlay;
    }
    // Sweep any orphan (stacked-bug leftovers or overlays attached to the
    // wrong parent after a fullscreen transition).
    document
      .querySelectorAll("#llm-subtitle-overlay")
      .forEach((el) => el.remove());
    overlay = document.createElement("div");
    overlay.id = "llm-subtitle-overlay";
    overlay.className = "llm-subtitle-overlay";
    overlay.innerHTML = `
      <div class="llm-subtitle-translated"></div>
      <div class="llm-subtitle-original"></div>
    `;
    target.appendChild(overlay);
    return overlay;
  }

  // Re-home the overlay whenever fullscreen state changes.
  function onFullscreenChange() {
    if (!overlay) return;
    const target = overlayTarget();
    if (overlay.parentElement !== target) {
      target.appendChild(overlay);
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange", onFullscreenChange);

  // Keep the overlay aligned with the actual <video> element. In fullscreen
  // the video fills the viewport, so viewport-based positioning happens to
  // line up; in windowed mode the video is only part of the page and the
  // overlay would otherwise stick to the page bottom.
  function positionOverlayToVideo() {
    if (!overlay) return;
    const target = overlayTarget();
    if (overlay.parentElement !== target) target.appendChild(overlay);
    const videos = getVideos();
    const v =
      videos.find((x) => !x.paused && x.readyState >= 2) || videos[0];
    if (!v) return;
    const vr = v.getBoundingClientRect();
    if (vr.width < 100 || vr.height < 100) return;
    const centerX = vr.left + vr.width / 2;
    // Position the overlay near the bottom of the video, inset ~8% of its
    // height (matches the default 8vh look used in fullscreen).
    const bottomOffset =
      window.innerHeight - vr.bottom + Math.max(16, vr.height * 0.08);
    overlay.style.setProperty("left", `${centerX}px`, "important");
    overlay.style.setProperty("bottom", `${bottomOffset}px`, "important");
    overlay.style.setProperty(
      "max-width",
      `${Math.min(vr.width * 0.92, window.innerWidth * 0.92)}px`,
      "important"
    );
  }

  function renderOverlay() {
    if (!settings?.enabled) {
      if (overlay) overlay.style.display = "none";
      hideNativeSubtitles(false);
      return;
    }
    // Per-cue mode decision:
    //   - Skip-language cue  → stand down: show the platform's native
    //     subtitle as-is, keep our overlay hidden (Method B).
    //   - Otherwise          → hide native, render via our overlay (Method A).
    const isSkipping =
      currentOriginal && shouldSkipTranslation(currentOriginal);
    if (isSkipping) {
      if (overlay) overlay.style.display = "none";
      hideNativeSubtitles(false);
      return;
    }
    const ov = ensureOverlay();
    const tEl = ov.querySelector(".llm-subtitle-translated");
    const oEl = ov.querySelector(".llm-subtitle-original");
    const hasText = currentOriginal || currentTranslated;
    ov.style.display = hasText ? "flex" : "none";
    tEl.textContent = currentTranslated || "";
    oEl.textContent = settings.showOriginal ? currentOriginal || "" : "";
    // Apply user-configurable font to the translated row. The original row
    // inherits the family but stays proportionally smaller.
    const fam = settings.fontFamily?.trim();
    const baseSize = Number(settings.fontSize) || 0;
    // Scale relative to the video's rendered height (reference: 1080p).
    // A user who sets 32px at 1080p gets ~64px on a 4K fullscreen and ~21px
    // on a 720p windowed player. Clamped so tiny thumbnails / absurdly large
    // video walls don't produce unreadable extremes.
    let scale = 1;
    const videos = getVideos();
    const v =
      videos.find((x) => !x.paused && x.readyState >= 2) || videos[0];
    if (v) {
      const h = v.getBoundingClientRect().height;
      if (h > 0) scale = Math.max(0.5, Math.min(3.0, h / 1080));
    }
    const sz = baseSize * scale;
    tEl.style.fontFamily = fam || "";
    tEl.style.fontSize = sz > 0 ? `${sz}px` : "";
    oEl.style.fontFamily = fam || "";
    oEl.style.fontSize = sz > 0 ? `${Math.round(sz * 0.65)}px` : "";
    // When translation equals original (e.g., skip-translation language hit),
    // hide the original row so the same line isn't shown twice.
    const duplicated =
      currentTranslated && currentTranslated === currentOriginal;
    // Apple's native English CC stays visible. A second English row in our
    // overlay wastes space and pushes the Chinese row up over the native text.
    const nativeOriginalVisible = platform.name === "appletv" &&
      !!globalThis.LLMSubtitleReader.readNative(v).text;
    oEl.style.display =
      settings.showOriginal && currentOriginal && !duplicated && !nativeOriginalVisible
        ? "block"
        : "none";
    // Always hide the native subtitle while enabled — our overlay is the
    // single source of truth.
    hideNativeSubtitles(true);
    // Align overlay to the actual video element (not the page viewport).
    positionOverlayToVideo();
  }

  function hideNativeSubtitles(on) {
    const styleId = "llm-subtitle-hide-native";
    let el = document.getElementById(styleId);
    // Apple TV uses broad subtitle/caption class names for both rendered cues
    // and its subtitle settings UI. Hiding those selectors also makes the
    // language menu disappear, so keep Apple's native English captions visible
    // and only add our translated overlay on top.
    if (platform.name === "appletv") {
      if (el) el.remove();
      return;
    }
    if (!on) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement("style");
    el.id = styleId;
    const selectors = platform.containerSelectors.filter(Boolean).join(", ");
    // Use opacity so the native subtitle's background box disappears too
    // (Disney+ renders an opaque black box behind its cues).
    el.textContent = selectors
      ? `${selectors} { opacity: 0 !important; }`
      : "";
    document.documentElement.appendChild(el);
  }

  // -------------- DOM helpers --------------
  function* walkAllElements(root) {
    // Walks regular DOM + open shadow roots.
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 1) {
        yield node;
        if (node.shadowRoot) stack.push(node.shadowRoot);
      }
      const children = node.children || node.childNodes;
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
  }

  function getVideos() {
    const vs = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") vs.push(el);
    }
    return vs;
  }

  // An element counts as "in the video region" only if its rect sits inside
  // (or right next to) a playing <video> element's rect. This is the key
  // filter that rejects Disney+ settings menus, audio/subtitle panels, and
  // any other UI chrome that happens to have a "subtitle"-ish class name.
  function isInsideVideoRegion(el, videos) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (const v of videos) {
      const vr = v.getBoundingClientRect();
      if (vr.width < 200 || vr.height < 150) continue;
      // Horizontal overlap: element must be roughly within the video's width
      if (r.right < vr.left + 10 || r.left > vr.right - 10) continue;
      // Vertical: anywhere inside the video, with small tolerance
      if (r.bottom < vr.top + 10 || r.top > vr.bottom + 20) continue;
      // Must be reasonably centered (subtitles sit mid-width, not at edges)
      const center = (r.left + r.right) / 2;
      const vCenter = (vr.left + vr.right) / 2;
      if (Math.abs(center - vCenter) > vr.width * 0.45) continue;
      return true;
    }
    return false;
  }

  function findByPlatformSelectors() {
    if (!platform.containerSelectors.length) return "";
    const joined = platform.containerSelectors.join(", ");
    const all = [];
    try {
      document.querySelectorAll(joined).forEach((el) => all.push(el));
    } catch (_) {}
    for (const el of walkAllElements(document)) {
      if (el.shadowRoot) {
        try {
          el.shadowRoot.querySelectorAll(joined).forEach((x) => all.push(x));
        } catch (_) {}
      }
    }
    // Prefer innermost matches only (drop any element that contains another match).
    const eligible = all.filter(el => globalThis.LLMSubtitleReader.isSubtitleElement(el));
    const leaves = eligible.filter((el) =>
      !eligible.some((other) => other !== el && el.contains(other))
    );
    // Keep only leaves that are visible AND painted over a <video> region.
    const videos = getVideos();
    const visible = leaves.filter((el) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity || "1") === 0) {
        // Our own hideNativeSubtitles uses opacity:0 — still allow that
        // only if the user-agent has opacity:0 because WE set it.
        if (!document.getElementById("llm-subtitle-hide-native")) return false;
      }
      return isInsideVideoRegion(el, videos);
    });
    const seenText = new Set();
    const texts = [];
    for (const el of visible) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (seenText.has(t)) continue;
      seenText.add(t);
      texts.push(t);
    }
    return texts.join("\n").trim();
  }

  // Generic detection: find text rendered over a video element.
  // Heuristics used:
  //   - must be inside a descendant of a <video>'s player container,
  //   - bounding rect overlaps the lower 65% of the video,
  //   - large-ish font size (>14px) or centered horizontally,
  //   - not a control / button / link / slider.
  function findGenericSubtitle() {
    const videos = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") videos.push(el);
    }
    if (!videos.length) return "";

    const lines = [];
    for (const video of videos) {
      const vr = video.getBoundingClientRect();
      if (vr.width < 200 || vr.height < 150) continue;

      // Find the player container — climb a few levels up.
      let container = video.parentElement;
      for (let i = 0; i < 6 && container?.parentElement; i++) {
        container = container.parentElement;
      }
      if (!container) continue;

      const candidates = [];
      for (const el of walkAllElements(container)) {
        if (!el.getBoundingClientRect) continue;
        if (el === video) continue;
        // Skip structural / interactive nodes
        const tag = el.tagName;
        if (!tag) continue;
        if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "VIDEO", "SVG", "PATH"].includes(tag)) continue;
        if (el.closest && el.closest("button, a, input, [role='button'], [role='slider'], [role='menuitem']"))
          continue;

        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 400) continue;
        // Subtitle lines rarely have huge nested word counts; filter heavy container nodes
        if (el.children && el.children.length > 6) continue;

        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Must overlap video bottom region
        const bottomStart = vr.top + vr.height * 0.35;
        if (r.bottom < bottomStart) continue;
        if (r.top > vr.bottom + 10) continue;
        if (r.left > vr.right || r.right < vr.left) continue;
        // Must be ~centered or at least not hugging a corner
        const center = (r.left + r.right) / 2;
        const vCenter = (vr.left + vr.right) / 2;
        if (Math.abs(center - vCenter) > vr.width * 0.4) continue;

        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (parseFloat(style.opacity || "1") < 0.1) continue;
        const fontSize = parseFloat(style.fontSize || "0");
        if (fontSize && fontSize < 13) continue;

        // Has *direct* text (not only descendants) OR is the innermost text-bearer
        const hasDirectText = [...el.childNodes].some(
          (n) => n.nodeType === 3 && n.nodeValue.trim()
        );
        if (!hasDirectText && el.children.length !== 0) continue;

        candidates.push({ el, text, fontSize, top: r.top });
      }

      if (!candidates.length) continue;

      // Prefer the largest font candidates (subtitles are typically large)
      candidates.sort((a, b) => b.fontSize - a.fontSize);
      const topSize = candidates[0].fontSize || 20;
      const chosen = candidates
        .filter((c) => c.fontSize >= topSize - 2)
        .sort((a, b) => a.top - b.top);

      const seenText = new Set();
      for (const c of chosen) {
        if (seenText.has(c.text)) continue;
        seenText.add(c.text);
        lines.push(c.text);
      }
    }

    // Dedup consecutive repeats
    const unique = [];
    for (const t of lines) if (unique[unique.length - 1] !== t) unique.push(t);
    return unique.join("\n").trim();
  }

  function extractSubtitle() {
    // Strict mode: only use the per-platform subtitle selectors. The generic
    // "scan anything near the video" fallback was catching UI chrome like
    // the Netflix "Skip Intro" button, title overlays, up-next countdowns,
    // etc. — anything inside the player container with visible text.
    if (platform.name === "appletv") {
      const native = globalThis.LLMSubtitleReader.readNative(getMainVideo());
      if (native.available) return native.text;
    }
    return findByPlatformSelectors();
  }

  function getMainVideo() {
    const videos = getVideos();
    return videos.find(v => findPlaybackDialog(v)) ||
      videos.find(v => !v.paused && v.readyState >= 2) || videos[0];
  }

  function languageKey(lang) {
    const key = String(lang || "").toLowerCase().split(/[-_]/)[0];
    return ({ eng: "en", spa: "es", zho: "zh", chi: "zh", jpn: "ja", und: "" })[key] ?? key;
  }

  // Native TextTrack timings already use video.currentTime. Pre-translate only
  // the next 30 seconds of the selected track, without changing its mode.
  function scanNativeCues(video) {
    const native = globalThis.LLMSubtitleReader.readNative(video);
    const selection = native.available ? languageKey(native.language) || "selected" : "off";
    if (selection !== selectedTrackLanguage) {
      selectedTrackLanguage = selection;
      cueLibrary.clear();
      cueList = [];
      sessionGeneration++;
      pending.clear();
      currentOriginal = "";
      currentTranslated = "";
      lastNativeScanAt = 0;
      renderOverlay();
    }
    if (!video || Date.now() - lastNativeScanAt < 1000) return native;
    lastNativeScanAt = Date.now();
    const upcoming = [];
    for (const track of Array.from(video.textTracks || [])) {
      if (track.mode !== "showing" || !["subtitles", "captions"].includes(track.kind)) continue;
      for (const cue of Array.from(track.cues || [])) {
        if (cue.endTime <= video.currentTime || cue.startTime > video.currentTime + 30) continue;
        const text = globalThis.LLMSubtitleReader.cueText(cue);
        upcoming.push({ start: cue.startTime, end: cue.endTime, text,
          language: track.language });
        if (upcoming.length >= 100) break;
      }
    }
    ingestParsedCues(upcoming);
    return native;
  }

  // -------------- translation --------------
  function normalize(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  async function translateText(text) {
    if (!settings?.enabled || !isPlayerPage()) return "";
    const generation = sessionGeneration;
    const key = normalize(text);
    if (!key) return "";
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);

    // Send the whole cue as ONE translation unit. Splitting on '\n' and then
    // joining batch entries with '\n---\n' confused some models: they'd
    // translate only the first line and echo the rest of the source text,
    // which our parser's byLine-fallback then accepted as "translations".
    const lines = [text];
    const t0 = Date.now();
    const promise = new Promise((resolve) => {
      const n = Math.max(0, settings?.contextLines ?? 0);
      const historySlice = n > 0 ? history.slice(-n) : [];
      chrome.runtime.sendMessage(
        {
          type: "translate",
          lines,
          history: historySlice,
        },
        (resp) => {
          if (generation !== sessionGeneration || !settings?.enabled) { resolve(""); return; }
          const dt = Date.now() - t0;
          if (chrome.runtime.lastError) {
            console.error(
              DEBUG_PREFIX,
              `translation runtime error after ${dt}ms:`,
              chrome.runtime.lastError.message
            );
            resolve("");
            return;
          }
          if (!resp?.ok) {
            console.error(
              DEBUG_PREFIX,
              `translation failed after ${dt}ms:`,
              resp?.error
            );
            resolve("");
            return;
          }
          const joined = resp.translations.join("\n");
          console.log(
            DEBUG_PREFIX,
            `translated in ${dt}ms:`,
            JSON.stringify(text),
            "→",
            JSON.stringify(joined)
          );
          cache.set(key, joined);
          if (cache.size > 500) {
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
          }
          lines.forEach((src, i) => {
            const tr = resp.translations[i];
            if (src && tr) {
              history.push({ source: src, translation: tr });
              if (history.length > HISTORY_MAX) history.shift();
            }
          });
          resolve(joined);
        }
      );
    });
    pending.set(key, promise);
    promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); });
    return promise;
  }

  async function handleCueChange(text) {
    const generation = sessionGeneration;
    // Safety: if the same cue has been on screen way longer than any real
    // subtitle, clear it. Disney+ occasionally leaves stale cue DOM around.
    if (
      text === currentOriginal &&
      currentOriginal &&
      cueSetAt &&
      Date.now() - cueSetAt > STALE_CUE_MS
    ) {
      currentOriginal = "";
      currentTranslated = "";
      lastLoggedText = null;
      cueSetAt = 0;
      renderOverlay();
      return;
    }
    if (text === currentOriginal) return;
    if (text && text !== lastLoggedText) {
      lastLoggedText = text;
      console.log(DEBUG_PREFIX, "detected cue:", text);
    } else if (!text && currentOriginal) {
      console.log(DEBUG_PREFIX, "cue cleared");
      lastLoggedText = null;
    }
    currentOriginal = text;
    cueSetAt = text ? Date.now() : 0;
    if (!text) {
      currentTranslated = "";
      renderOverlay();
      return;
    }
    // Source language is in the user's skip list — no API call, renderOverlay
    // will stand down (Method B: let the native subtitle show through).
    if (shouldSkipTranslation(text)) {
      console.log(
        DEBUG_PREFIX,
        `skipped (${detectLang(text)} in skip list); showing native`
      );
      currentTranslated = text;
      renderOverlay();
      return;
    }
    currentTranslated = "";
    renderOverlay();

    const now = Date.now();
    if (now - lastTranslationAt < MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
    }
    lastTranslationAt = Date.now();

    if (generation !== sessionGeneration || text !== currentOriginal || !settings?.enabled) return;

    const captured = text;
    const translation = await translateText(text);
    // Strict sync: only show the translation if the cue is still on screen.
    // If it already ended, discard — resurrecting a finished cue would leave
    // stale text on top of the next line. The cache has been filled either
    // way, so the same text reappearing later shows instantly.
    if (captured === currentOriginal && generation === sessionGeneration && settings?.enabled) {
      currentTranslated = translation;
      renderOverlay();
    }
  }

  // -------------- pre-translation via network interception --------------

  function parseTimeVTT(s) {
    const m = s.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return NaN;
    return (
      (parseInt(m[1] || "0") * 3600) +
      parseInt(m[2]) * 60 +
      parseInt(m[3]) +
      parseInt(m[4]) / Math.pow(10, String(m[4]).length)
    );
  }

  function parseWebVTT(text) {
    const out = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      const tli = lines.findIndex((l) => /-->/.test(l));
      if (tli === -1) continue;
      const m = lines[tli].match(/(\S+)\s*-->\s*(\S+)/);
      if (!m) continue;
      const start = parseTimeVTT(m[1]);
      const end = parseTimeVTT(m[2]);
      if (!isFinite(start) || !isFinite(end)) continue;
      // Match native cue cleanup so e.g. &gt;&gt; and >> share one cache/API
      // request instead of being translated twice via network and TextTrack.
      const content = globalThis.LLMSubtitleReader.cueText({
        text: lines.slice(tli + 1).join("\n"),
      });
      if (content) out.push({ start, end, text: content });
    }
    return out;
  }

  function parseTTMLTime(s) {
    if (!s) return NaN;
    const hms = s.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
    if (hms) {
      return (
        parseInt(hms[1]) * 3600 +
        parseInt(hms[2]) * 60 +
        parseInt(hms[3]) +
        (hms[4] ? parseInt(hms[4]) / Math.pow(10, hms[4].length) : 0)
      );
    }
    const sec = s.match(/^([\d.]+)s$/);
    if (sec) return parseFloat(sec[1]);
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }

  function parseTTML(text) {
    const out = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
    } catch (_) {
      return out;
    }
    const ps = doc.getElementsByTagName("p");
    for (const p of ps) {
      const begin = p.getAttribute("begin") || p.getAttribute("b");
      const end = p.getAttribute("end") || p.getAttribute("e");
      const start = parseTTMLTime(begin);
      const stop = parseTTMLTime(end);
      if (!isFinite(start) || !isFinite(stop)) continue;
      // Preserve line breaks from <br/>
      const clone = p.cloneNode(true);
      clone.querySelectorAll && clone.querySelectorAll("br").forEach((br) => {
        br.replaceWith("\n");
      });
      const content = (clone.textContent || "").trim();
      if (content) out.push({ start, end: stop, text: content });
    }
    return out;
  }

  // YouTube srv1 XML: <transcript><text start="..." dur="...">...</text></transcript>
  function parseYouTubeXML(text) {
    const out = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
    } catch (_) {
      return out;
    }
    const els = doc.getElementsByTagName("text");
    for (const el of els) {
      const start = parseFloat(el.getAttribute("start") || "");
      const dur = parseFloat(el.getAttribute("dur") || "0");
      if (!isFinite(start)) continue;
      const txt = (el.textContent || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (txt) out.push({ start, end: start + (dur || 2), text: txt });
    }
    return out;
  }

  // YouTube json3: { events: [{ tStartMs, dDurationMs, segs: [{utf8}] }, ...] }
  function parseYouTubeJSON3(text) {
    const out = [];
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return out;
    }
    const events = data?.events || [];
    for (const ev of events) {
      const start = (ev.tStartMs || 0) / 1000;
      const dur = (ev.dDurationMs || 0) / 1000;
      const segs = ev.segs || [];
      const txt = segs
        .map((s) => s.utf8 || "")
        .join("")
        .trim();
      // YouTube emits timing-keyframe events with empty text — skip them.
      if (txt && dur > 0) out.push({ start, end: start + dur, text: txt });
    }
    return out;
  }

  function ingestParsedCues(cues) {
    if (!settings?.enabled || !isPlayerPage() || !cues.length) return 0;
    let added = 0;
    for (const c of cues.slice(0, 4096)) {
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start ||
          typeof c.text !== "string" || !c.text.trim() || c.text.length > 4000) continue;
      const lang = languageKey(c.language);
      if (platform.name === "appletv" && (selectedTrackLanguage === "off" ||
          (lang && selectedTrackLanguage !== "selected" && lang !== selectedTrackLanguage))) continue;
      const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
      if (cueLibrary.has(key)) continue;
      cueLibrary.set(key, {
        start: c.start,
        end: c.end,
        text: c.text,
        translation: null,
        translating: false,
        retryAt: 0,
      });
      if (cueLibrary.size > 2000) cueLibrary.delete(cueLibrary.keys().next().value);
      added++;
    }
    if (added) {
      cueList = [...cueLibrary.values()].sort((a, b) => a.start - b.start);
      lastCueCaptureAt = Date.now();
      scheduleBatchTranslation();
    }
    return added;
  }

  let batchSchedulerRunning = false;
  async function scheduleBatchTranslation() {
    if (batchSchedulerRunning || !settings?.enabled || !isPlayerPage()) return;
    batchSchedulerRunning = true;
    const generation = sessionGeneration;
    try {
      while (settings?.enabled && generation === sessionGeneration && isPlayerPage()) {
        // Don't waste API calls on cues in the skip-translation list.
        // Mark them as "translated" with their source text so time-sync /
        // cache hits display them immediately.
        for (const c of cueList) {
          if (c.translation === null && shouldSkipTranslation(c.text)) {
            c.translation = c.text;
            cache.set(normalize(c.text), c.text);
          }
        }
        const video = getMainVideo();
        if (!video || video.paused || !Number.isFinite(video.currentTime)) break;
        const now = video.currentTime;
        const pool = cueList.filter(c => c.translation === null && !c.translating &&
          c.retryAt <= Date.now() && c.end > now && c.start <= now + 30)
          .sort((a, b) => a.start - b.start).slice(0, 2);
        if (!pool.length) break;
        // Same pending/cache path as live cues, so a prefetch and a visible cue
        // cannot charge twice for the same text. Failures back off, not spin.
        await Promise.all(pool.map(async c => {
          c.translating = true;
          try {
            const translated = await translateText(c.text);
            if (generation === sessionGeneration) c.translation = translated || null;
            c.retryAt = Date.now() + 15000;
          } finally { c.translating = false; }
        }));
      }
    } finally {
      batchSchedulerRunning = false;
    }
  }

  // Listen for subtitle captures from the injected MAIN-world script.
  // Validate origin and source to reject messages from page scripts trying
  // to spoof subtitle segments.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.origin && e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== "__llm-subtitle-capture") return;
    if (!settings?.enabled || !isPlayerPage() || platform.name === "appletv") return;
    if (typeof d.text !== "string" || d.text.length > 8 * 1024 * 1024) return;
    const text = String(d.text || "");
    let cues = [];
    if (text.startsWith("WEBVTT")) cues = parseWebVTT(text);
    else if (/<tt[\s>]/i.test(text)) {
      cues = parseTTML(text);
      // TTML carries the source language in xml:lang — use it as an
      // authoritative hint so kanji-only Japanese lines aren't mis-classified
      // as Chinese later on.
      const langMatch =
        text.match(/xml:lang="([^"]+)"/i) || text.match(/\slang="([^"]+)"/i);
      const display = langMatch ? langCodeToDisplay(langMatch[1]) : null;
      if (display) setSessionLanguage(display);
    } else if (/^\s*\{\s*"(wireMagic|events)"/.test(text)) {
      cues = parseYouTubeJSON3(text);
    } else if (/<transcript/i.test(text.slice(0, 200))) {
      cues = parseYouTubeXML(text);
    }
    // YouTube embeds the source language in the timedtext URL (`&lang=ja` etc.)
    if (!sessionLanguage && d.url) {
      const m = d.url.match(/[?&]lang=([a-zA-Z-]+)/);
      const display = m ? langCodeToDisplay(m[1]) : null;
      if (display) setSessionLanguage(display);
    }
    if (cues.length) {
      const added = ingestParsedCues(cues);
      const sample = cues[0];
      console.log(
        DEBUG_PREFIX,
        `captured subtitle segment (${cues.length} cues, ${added} new) ` +
          `first cue: ${sample.start.toFixed(2)}s–${sample.end.toFixed(2)}s "${sample.text.slice(0, 40)}" ` +
          `from ${d.url?.slice(0, 80)}`
      );
    }
  });

  // Time-based display: prefer pre-translated cues over DOM extraction when
  // available. Returns true if a cue was shown (and the DOM polling should
  // skip this tick).
  function tickTimeSyncDisplay() {
    if (!cueList.length) return false;
    const videos = getVideos();
    if (!videos.length) return false;
    const video = videos.find((v) => !v.paused && v.readyState >= 2) || videos[0];
    if (!isFinite(video.currentTime)) return false;
    const t = video.currentTime;
    // Linear scan is fine (< a few hundred cues per segment window).
    // Pick the latest cue whose range contains t.
    let match = null;
    for (const c of cueList) {
      if (c.start <= t && t <= c.end) {
        match = c;
      } else if (c.start > t) {
        break;
      }
    }
    if (!match) {
      // Don't block the DOM fallback — cue times may be segment-relative
      // (not aligned to video.currentTime). Let DOM extraction handle it.
      return false;
    }
    // If we don't yet have a translation for this cue, check the main cache
    // (populated by scheduleBatchTranslation). If still absent, let DOM
    // fallback handle it so we don't race with the batch translator.
    // Treat empty string same as null — a previous batch may have recorded
    // a failure, and we want to retry / fall back rather than display blank.
    if (!match.translation) {
      const cached = cache.get(normalize(match.text));
      if (cached) match.translation = cached;
      else return false; // fall through to DOM
    }
    // Sanity check against DOM: if the page is currently rendering a
    // different subtitle than what the timeline says, trust the DOM. This
    // guards against presentationTimeOffset mismatches (video.currentTime
    // and TTML cue times can be off by many seconds on some titles).
    const domText = extractSubtitle();
    if (domText && normalize(domText) !== normalize(match.text)) {
      return false;
    }
    if (match.text !== currentOriginal) {
      console.log(DEBUG_PREFIX, "sync cue:", match.text);
      lastLoggedText = match.text;
      currentOriginal = match.text;
      cueSetAt = Date.now();
    }
    const translated = match.translation || "";
    if (translated !== currentTranslated) {
      currentTranslated = translated;
    }
    renderOverlay();
    return true;
  }

  // -------------- observer --------------
  let pollTimer = null;
  let diagTimer = null;
  let retryTimer = null;

  function diagnostic() {
    const videos = [];
    for (const el of walkAllElements(document)) {
      if (el.tagName === "VIDEO") videos.push(el);
    }
    const platformMatches = [];
    for (const sel of platform.containerSelectors) {
      try {
        const n = document.querySelectorAll(sel).length;
        if (n > 0) platformMatches.push(`${sel} (${n})`);
      } catch (_) {}
    }
    const playingVideos = videos.filter((v) => !v.paused && v.readyState >= 2);
    const translatedCount = cueList.filter((c) => c.translation !== null).length;
    const trackInfo = videos.flatMap(v => Array.from(v.textTracks || []).map(t =>
      `${t.kind}/${t.language}/${t.mode}:cues=${t.cues?.length ?? "unavailable"},active=${t.activeCues?.length ?? "unavailable"}`));
    console.log(
      DEBUG_PREFIX,
      `diag: videos=${videos.length} playing=${playingVideos.length} ` +
        `platformMatches=[${platformMatches.join("; ") || "none"}] ` +
        `capturedCues=${cueList.length} preTranslated=${translatedCount} ` +
        `tracks=[${trackInfo.join("; ")}] ` +
        `lastCapture=${lastCueCaptureAt ? `${Math.round((Date.now() - lastCueCaptureAt) / 1000)}s ago` : "never"} ` +
        `lastCue=${JSON.stringify(currentOriginal || "")}`
    );
  }

  function startObserving() {
    stopObserving();
    const check = () => {
      if (platform.name === "appletv") scanNativeCues(getMainVideo());
      handleCueChange(extractSubtitle());
      // Re-align each tick so overlay follows the video through page scroll,
      // window resize, and windowed-player drags.
      positionOverlayToVideo();
    };
    // Poll-based detection is more reliable than MutationObserver for
    // shadow DOM / React-rebuilt nodes that many players use.
    pollTimer = setInterval(check, platform.name === "appletv" ? 100 : 200);
    check();
    console.log(DEBUG_PREFIX, "observer started; platform =", platform.name);
    // One diagnostic dump every 3 seconds for the first 15 seconds so the
    // user can see whether we find videos / platform containers at all.
    let dumps = 0;
    diagTimer = setInterval(() => {
      diagnostic();
      if (++dumps >= 5) {
        clearInterval(diagTimer);
        diagTimer = null;
      }
    }, 3000);
    // Periodically retry untranslated cues. This recovers from transient
    // provider errors (Gemini 503 / 429) that left some slots as null.
    retryTimer = setInterval(() => {
      if (cueList.some((c) => c.translation === null && !c.translating)) {
        scheduleBatchTranslation();
      }
    }, 5000);
  }

  function stopObserving() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (diagTimer) clearInterval(diagTimer);
    diagTimer = null;
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
    currentOriginal = "";
    currentTranslated = "";
    lastLoggedText = null;
    renderOverlay();
  }

  // -------------- lifecycle --------------
  async function loadSettings() {
    settings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getSettings" }, (s) => resolve(s || {}));
    });
  }

  async function applySettings() {
    sessionGeneration++;
    await loadSettings();
    cache.clear();
    pending.clear();
    history.length = 0;
    cueLibrary.clear();
    cueList = [];
    lastNativeScanAt = 0;
    const active = !!settings?.enabled && isPlayerPage();
    hideNativeSubtitles(active);
    if (active) startObserving();
    else stopObserving();
    renderOverlay();
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "sync") return;
    applySettings();
  });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      currentOriginal = "";
      currentTranslated = "";
      lastLoggedText = null;
      cueLibrary.clear();
      cueList = [];
      lastCueCaptureAt = 0;
      sessionLanguage = null; // new video may be a different language
      selectedTrackLanguage = "";
      console.log(
        DEBUG_PREFIX,
        `navigation detected (${location.pathname}); re-evaluating`
      );
      // Re-decide whether this URL is a player page; Netflix browse → /watch/
      // and back should toggle the observer on/off accordingly.
      applySettings();
    } else if (platform.name === "appletv" && settings &&
        (!!pollTimer !== (!!settings.enabled && isPlayerPage()))) {
      // Live broadcasts can open/close a modal on /channel/ without changing
      // the URL. Reconcile player state as well as SPA route changes.
      applySettings();
    }
  }, 1000);

  applySettings();
})();
