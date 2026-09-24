// Passive, document_start MAIN-world capture. Never changes text track modes,
// fetches extra resources, consumes a player's response body, or decrypts media.
(() => {
  if (window.__llmSubtitleCaptureLoaded) return;
  window.__llmSubtitleCaptureLoaded = true;
  const TAG = "__llm-subtitle-capture";
  const MAX_BYTES = 8 * 1024 * 1024;
  let enabled = false;
  let page = location.href;
  let early = [];
  let earlyBytes = 0;

  function forward(data) {
    if (!enabled) {
      // Small startup buffer covers requests before settings finish loading.
      if (early && earlyBytes + JSON.stringify(data).length < 1024 * 1024) {
        early.push(data);
        earlyBytes += JSON.stringify(data).length;
      }
      return;
    }
    window.postMessage({ source: TAG, page: location.href, ...data }, location.origin);
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin ||
        e.data?.source !== "__llm-subtitle-control" || e.data.page !== location.href) return;
    enabled = e.data.enabled === true;
    if (page !== location.href) early = [];
    page = location.href;
    const queued = early || [];
    early = null;
    earlyBytes = 0;
    if (enabled) queued.forEach(forward);
  });

  const urlString = (input) => {
    try { return typeof input === "string" ? input : input?.url || String(input); }
    catch (_) { return ""; }
  };
  const subtitleURL = (url) => /\.(vtt|ttml|ttml2|dfxp)([?#]|$)|subtitle|caption|timedtext|\/cc\//i.test(url);
  const subtitleType = (ct) => /text\/vtt|application\/(ttml|ttaf|xml)|text\/xml/i.test(ct);
  const binaryType = (ct) => /mp4|octet-stream/i.test(ct);
  function processText(url, text, contentType, requestPage) {
    if (requestPage !== location.href) return;
    if (typeof text !== "string" || text.length > MAX_BYTES) return;
    const head = text.slice(0, 1000).trimStart();
    if (/^WEBVTT|<(?:\w+:)?tt[\s>]|<transcript|^\{\s*"(wireMagic|events)"/i.test(head)) {
      forward({ kind: "text", url, text, contentType });
    }
  }

  // Network timestamps may be relative to a manifest period. These cues only
  // warm the cache; native tracks / MSE provide authoritative display time.
  const networkParsers = new Map();
  function processBinary(url, data, requestPage) {
    if (requestPage !== location.href) return;
    if (!globalThis.LLMSubtitleParser || !data || data.byteLength > MAX_BYTES) return;
    let key;
    try {
      const u = new URL(url, location.href);
      key = u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1) +
        "|" + (u.searchParams.get("lang") || u.searchParams.get("language") || "");
    } catch (_) { return; }
    if (!networkParsers.has(key)) {
      if (networkParsers.size >= 16) networkParsers.delete(networkParsers.keys().next().value);
      networkParsers.set(key, globalThis.LLMSubtitleParser.createParser());
    }
    emitParsed(networkParsers.get(key).parse(data), false, 0, url);
  }
  function emitParsed(result, timeAligned, offset, url = "MSE subtitle buffer") {
    if (result.rejected) return;
    if (result.cues.length || result.ttml.length) {
      forward({ kind: "parsed", cues: result.cues, ttml: result.ttml,
        timeAligned, offset, url, tracks: result.tracks });
    }
  }

  // Hard cap cloned response reads. Only subtitle-indicated URLs/types qualify.
  async function inspectResponse(resp, url, ct, requestPage) {
    if (requestPage !== location.href) return;
    if (Number(resp.headers.get("content-length")) > MAX_BYTES) return;
    const reader = resp.clone().body?.getReader();
    if (!reader) return;
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { void reader.cancel(); return; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let p = 0;
      for (const chunk of chunks) { bytes.set(chunk, p); p += chunk.length; }
      processText(url, new TextDecoder().decode(bytes), ct, requestPage);
      if (binaryType(ct) || /\.(mp4|m4s)([?#]|$)/i.test(url)) processBinary(url, bytes, requestPage);
    } finally { reader.releaseLock(); }
  }
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = async function (...args) {
    const requestPage = location.href;
    const resp = await originalFetch.apply(this, args);
    try {
      const url = resp.url || urlString(args[0]);
      const ct = resp.headers.get("content-type") || "";
      if ((enabled || early) && (subtitleURL(url) || subtitleType(ct))) {
        void inspectResponse(resp, url, ct, requestPage).catch(() => {});
      }
    } catch (_) {}
    return resp;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrURLs = new WeakMap();
  const observedXHRs = new WeakSet();
  XMLHttpRequest.prototype.open = function (method, url) {
    xhrURLs.set(this, { url: urlString(url), page: location.href });
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (!observedXHRs.has(this)) {
      observedXHRs.add(this);
      this.addEventListener("load", function () {
        try {
          if (!enabled && !early) return;
          const request = xhrURLs.get(this);
          if (!request || request.page !== location.href) return;
          const url = this.responseURL || request.url || "";
          const ct = this.getResponseHeader("content-type") || "";
          if (!subtitleURL(url) && !subtitleType(ct)) return;
          if (!this.responseType || this.responseType === "text") processText(url, this.responseText, ct, request.page);
          else if (this.responseType === "arraybuffer") {
            if (this.response?.byteLength > MAX_BYTES) return;
            processText(url, new TextDecoder().decode(this.response), ct, request.page);
            processBinary(url, this.response, request.page);
          } else if (this.responseType === "blob" && this.response?.size <= MAX_BYTES) {
            void this.response.arrayBuffer().then((b) => {
              processText(url, new TextDecoder().decode(b), ct, request.page);
              processBinary(url, b, request.page);
            }).catch(() => {});
          }
        } catch (_) {}
      });
    }
    return originalSend.apply(this, arguments);
  };

  // Each SourceBuffer retains its own init state. Preserve playback behavior.
  if (globalThis.SourceBuffer && globalThis.LLMSubtitleParser) {
    const states = new WeakMap();
    const originalAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      const result = originalAppend.apply(this, arguments);
      try {
        if (!data || data.byteLength > MAX_BYTES) return result;
        let state = states.get(this);
        if (!state) {
          state = { parser: globalThis.LLMSubtitleParser.createParser(), subtitle: null };
          states.set(this, state);
        }
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const header = String.fromCharCode(...bytes.subarray(4, 8));
        const init = header === "ftyp" || header === "moov";
        if (state.subtitle === false && !init) return result;
        if (!enabled && !early && !init) return result;
        const parsed = state.parser.parse(bytes);
        if (init) state.subtitle = parsed.tracks.some(t => t.codec === "wvtt" || t.codec === "stpp");
        if (enabled || early) emitParsed(parsed, true, Number(this.timestampOffset) || 0);
      } catch (_) {} // capture must never break playback
      return result;
    };
  }
})();
