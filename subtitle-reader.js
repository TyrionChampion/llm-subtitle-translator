/* Read and augment native captions without changing the selected tracks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LLMSubtitleReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const interactiveTags = new Set([
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP",
    "MENU", "MENUITEM", "AMP-CAPTIONS-CONTROL",
  ]);
  const interactiveRoles = new Set([
    "button", "checkbox", "combobox", "listbox", "menu", "menubar",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio",
    "radiogroup", "scrollbar", "searchbox", "slider", "spinbutton",
    "switch", "tab", "tablist", "textbox", "toolbar",
  ]);

  function asArray(list) {
    try { return list ? Array.from(list) : []; } catch (_) { return []; }
  }

  function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()];
      const hex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(code);
    });
  }

  // Translation must never feed back into detection, context or API requests.
  const bilingualCues = new WeakMap();

  function cueText(cue) {
    const saved = bilingualCues.get(cue);
    if (saved && cue.text === saved.rendered) return saved.source;
    if (saved && cue.text.startsWith(saved.rendered)) {
      return cueText({ text: saved.raw + cue.text.slice(saved.rendered.length) });
    }
    let text;
    try {
      if (typeof cue.getCueAsHTML === "function") {
        const fragment = cue.getCueAsHTML();
        if (fragment && typeof fragment.textContent === "string") text = fragment.textContent;
      }
    } catch (_) { /* Some browser cue implementations do not expose this method. */ }
    if (typeof text !== "string") {
      if (typeof cue.text !== "string") return "";
      // Strip WebVTT markup before decoding entities: escaped angle brackets are text.
      text = decodeEntities(cue.text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, ""));
    }
    return text.replace(/\r\n?/g, "\n").replace(/[\u0000\ufeff]/g, "")
      .split("\n").map(line => line.replace(/[^\S\n]+/g, " ").trim())
      .filter(Boolean).join("\n").trim();
  }

  function currentCues(list, time) {
    return asArray(list).filter(cue => cue && Number.isFinite(cue.startTime)
      && Number.isFinite(cue.endTime) && cue.startTime <= time && time < cue.endTime);
  }

  function createNativeBilingualRenderer() {
    const modified = new Map();
    function setText(cue, text, track) {
      if (cue.text === text) return;
      const previous = cue.text;
      cue.text = text;
      // Chromium can retain an active cue's old display tree after text changes.
      // Reinsert the same cue to repaint, preserving its timing and positioning.
      if (typeof track?.removeCue === "function" && typeof track?.addCue === "function" &&
          asArray(track.cues).includes(cue)) {
        try {
          track.removeCue(cue);
          track.addCue(cue);
        } catch (error) {
          cue.text = previous;
          if (!asArray(track.cues).includes(cue)) track.addCue(cue);
          throw error;
        }
      }
    }
    function restoreCue(cue, saved) {
      try {
        // Live CC can rewrite a cue in place. Never overwrite the player's update.
        if (cue.text.startsWith(saved.rendered)) {
          setText(cue, saved.raw + cue.text.slice(saved.rendered.length), saved.track);
        }
      } catch (_) { /* Detached or read-only cue. */ }
      bilingualCues.delete(cue);
      modified.delete(cue);
    }
    function restore() {
      for (const [cue, saved] of modified) restoreCue(cue, saved);
    }
    function sync(video, source, translation) {
      const active = [];
      const owners = new Map();
      try {
        for (const track of asArray(video?.textTracks)) {
          if (track.mode !== "showing" || !["subtitles", "captions"].includes(track.kind)) continue;
          let cues = currentCues(track.activeCues, video.currentTime);
          if (!cues.length) cues = currentCues(track.cues, video.currentTime);
          active.push(...cues.filter(cue => cueText(cue)));
          for (const cue of cues) owners.set(cue, track);
        }
      } catch (_) { restore(); return false; }
      const text = [...new Set(active.map(cueText))].join("\n");
      const normalize = value => value.replace(/\s+/g, " ").trim();
      // Append once, after the final source cue, even when a sentence spans cues.
      const target = source && translation && translation !== source &&
        normalize(text) === normalize(source) ? active.at(-1) : null;
      for (const [cue, saved] of modified) {
        if (cue !== target || cue.text !== saved.rendered) restoreCue(cue, saved);
      }
      if (!target || typeof target.text !== "string") return false;
      const previous = modified.get(target);
      const raw = previous ? previous.raw : target.text;
      const original = previous ? previous.source : cueText(target);
      // VTTCue.text is WebVTT, not HTML. Escape literal translation characters.
      const escaped = translation.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const rendered = `${raw}\n${escaped}`;
      try {
        setText(target, rendered, owners.get(target));
        if (target.text !== rendered) throw new Error("cue text is read-only");
      } catch (_) { restore(); return false; }
      const saved = { raw, source: original, rendered, track: owners.get(target) };
      modified.set(target, saved);
      bilingualCues.set(target, saved);
      return true;
    }
    return { sync, restore };
  }

  function readNative(video) {
    const result = { available: false, text: "", language: "" };
    if (!video) return result;
    let tracks, time;
    try {
      tracks = asArray(video.textTracks);
      time = video.currentTime;
    } catch (_) { return result; }
    const texts = new Set();
    for (const track of tracks) {
      try {
        if (!track || track.mode !== "showing"
          || (track.kind !== "subtitles" && track.kind !== "captions")) continue;
        result.available = true;
        if (!result.language && typeof track.language === "string") result.language = track.language.trim();
        if (!Number.isFinite(time)) continue;
        let cues = currentCues(track.activeCues, time);
        // activeCues may lag behind currentTime after a seek or be unavailable.
        if (!cues.length) cues = currentCues(track.cues, time);
        for (const cue of cues) {
          const text = cueText(cue);
          if (text) texts.add(text);
        }
      } catch (_) { /* A detached/inaccessible track must not break other tracks. */ }
    }
    result.text = Array.from(texts).join("\n");
    return result;
  }

  function attribute(el, name) {
    try { return typeof el.getAttribute === "function" ? el.getAttribute(name) || "" : ""; }
    catch (_) { return ""; }
  }

  function parentAcrossShadow(el) {
    if (el.parentElement) return el.parentElement;
    if (el.parentNode && el.parentNode.host) return el.parentNode.host;
    try {
      const root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
      return root && root.host ? root.host : null;
    } catch (_) { return null; }
  }

  function isSubtitleElement(el) {
    if (!el || (el.nodeType != null && el.nodeType !== 1)) return false;
    const seen = new Set();
    for (let node = el; node && !seen.has(node); node = parentAcrossShadow(node)) {
      seen.add(node);
      const tag = String(node.tagName || node.localName || "").toUpperCase();
      if (interactiveTags.has(tag)) return false;
      const id = String(node.id || attribute(node, "id"));
      let classes = typeof node.className === "string" ? node.className : attribute(node, "class");
      if (node.className && typeof node.className.baseVal === "string") classes = node.className.baseVal;
      const tokens = String(classes || "").split(/\s+/);
      if (id.startsWith("llm-subtitle-") || tokens.some(token => token.startsWith("llm-subtitle-"))) return false;
      if (tokens.some(token => /^video-player__controls?(?:--|$)/.test(token))) return false;
      if (tokens.includes("video-metadata")) return false; // Apple's program title/time, not CC.
      const roles = attribute(node, "role").toLowerCase().split(/\s+/);
      if (roles.some(role => interactiveRoles.has(role))) return false;
      if (node.isContentEditable === true) return false;
    }
    return true;
  }

  return { readNative, isSubtitleElement, cueText, createNativeBilingualRenderer };
});
