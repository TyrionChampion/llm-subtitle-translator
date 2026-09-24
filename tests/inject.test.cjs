const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "inject.js"), "utf8");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello from the track\n";
const bytes = text => new TextEncoder().encode(text);
const flush = () => new Promise(resolve => setImmediate(resolve));

function response(text = VTT, options = {}) {
  const state = { clones: 0, originalReads: 0, cloneReads: 0, cancelled: 0, released: 0 };
  const chunks = options.chunks || [bytes(text)];
  const headers = {
    "content-type": options.type || "text/vtt",
    "content-length": options.contentLength == null ? String(chunks.reduce((n, c) => n + c.length, 0)) : String(options.contentLength),
  };
  const resp = {
    url: options.url || "https://video.example/subtitles/en/segment.vtt",
    headers: { get(name) { return headers[name.toLowerCase()] || null; } },
    body: { getReader() { state.originalReads++; throw new Error("player body must not be read"); } },
    clone() {
      state.clones++;
      let index = 0;
      return { body: { getReader() { return {
        async read() {
          state.cloneReads++;
          return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
        },
        async cancel() { state.cancelled++; },
        releaseLock() { state.released++; },
      }; } } };
    },
  };
  return { resp, state };
}

function harness(options = {}) {
  const posted = [];
  const events = new Map();
  const location = { href: "https://tv.apple.com/us/sporting-event/first", origin: "https://tv.apple.com" };
  const fetchCalls = [];
  class FakeXHR {
    constructor() {
      this.listeners = new Map();
      this.responseType = "";
      this.responseText = "";
      this.responseURL = "";
      this.contentType = "text/vtt";
      this.sent = 0;
    }
    open(...args) { this.openArgs = args; return "open-result"; }
    send(...args) { this.sent++; this.sendArgs = args; return "send-result"; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    getResponseHeader(name) { return name.toLowerCase() === "content-type" ? this.contentType : null; }
    load() { for (const fn of this.listeners.get("load") || []) fn.call(this); }
  }
  class FakeSourceBuffer {
    constructor() { this.timestampOffset = 0; this.appends = []; }
    appendBuffer(data) {
      if (this.appendError) throw this.appendError;
      this.appends.push(data);
      return "append-result";
    }
  }
  const window = {
    postMessage(data, origin) { posted.push({ data, origin }); },
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(fn);
    },
    fetch(...args) {
      fetchCalls.push({ receiver: this, args });
      return options.fetch ? options.fetch(...args) : Promise.resolve(response().resp);
    },
  };
  const parseCalls = [];
  const context = vm.createContext({ window, location, XMLHttpRequest: FakeXHR, SourceBuffer: FakeSourceBuffer,
    URL, TextDecoder, Uint8Array, ArrayBuffer, console,
    LLMSubtitleParser: options.parse ? { createParser() { return { parse(data) {
      parseCalls.push(data);
      return options.parse(data);
    } }; } } : undefined,
  });
  vm.runInContext(source, context, { filename: "inject.js" });
  function control(enabled, overrides = {}) {
    const event = { source: window, origin: location.origin,
      data: { source: "__llm-subtitle-control", page: location.href, enabled }, ...overrides };
    for (const fn of events.get("message") || []) fn(event);
  }
  return { context, window, location, posted, control, FakeXHR, FakeSourceBuffer, fetchCalls, parseCalls };
}

test("fetch returns the original response and reads only a clone", async () => {
  const { resp, state } = response();
  const h = harness({ fetch: async () => resp });
  h.control(true);
  const request = { url: resp.url };
  const init = { credentials: "same-origin" };
  const returned = await h.window.fetch(request, init);
  await flush();
  assert.equal(returned, resp);
  assert.equal(state.originalReads, 0);
  assert.equal(state.clones, 1);
  assert.equal(state.released, 1);
  assert.equal(h.fetchCalls[0].receiver, h.window);
  assert.equal(h.fetchCalls[0].args[0], request);
  assert.equal(h.fetchCalls[0].args[1], init);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].data.text, VTT);
  assert.equal(h.posted[0].data.page, h.location.href);
  assert.equal(h.posted[0].origin, h.location.origin);
});

test("XHR arraybuffer WebVTT is decoded and original methods/arguments are preserved", () => {
  const h = harness();
  h.control(true);
  const xhr = new h.FakeXHR();
  xhr.responseType = "arraybuffer";
  xhr.response = bytes(VTT).buffer;
  assert.equal(xhr.open("GET", "https://video.example/subtitles/en.vtt", true), "open-result");
  assert.equal(xhr.send(null), "send-result");
  xhr.load();
  assert.deepEqual(xhr.openArgs, ["GET", "https://video.example/subtitles/en.vtt", true]);
  assert.deepEqual(xhr.sendArgs, [null]);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].data.text, VTT);
});

test("reusing an XHR installs one load listener and captures the current URL once", () => {
  const h = harness();
  h.control(true);
  const xhr = new h.FakeXHR();
  xhr.responseText = VTT;
  xhr.open("GET", "https://video.example/subtitles/one.vtt");
  xhr.send();
  xhr.load();
  xhr.open("GET", "https://video.example/subtitles/two.vtt");
  xhr.send();
  xhr.load();
  assert.equal(xhr.listeners.get("load").length, 1);
  assert.equal(h.posted.length, 2);
  assert.match(h.posted[1].data.url, /two\.vtt$/);
});

test("explicit disable drops startup captures and does not buffer disabled traffic", async () => {
  const h = harness();
  await h.window.fetch("https://video.example/subtitles/early.vtt");
  await flush();
  assert.equal(h.posted.length, 0);
  h.control(false);
  await h.window.fetch("https://video.example/subtitles/disabled.vtt");
  const xhr = new h.FakeXHR();
  xhr.responseText = VTT;
  xhr.open("GET", "https://video.example/subtitles/disabled.vtt");
  xhr.send();
  xhr.load();
  await flush();
  h.control(true);
  assert.equal(h.posted.length, 0);
});

test("startup captures flush once only after a valid same-window enable message", async () => {
  const h = harness();
  await h.window.fetch("https://video.example/subtitles/early.vtt");
  await flush();
  h.control(true, { origin: "https://unrelated.example" });
  h.control(true, { source: {} });
  h.control(true, { data: { source: "__llm-subtitle-control", page: "https://tv.apple.com/other", enabled: true } });
  assert.equal(h.posted.length, 0);
  h.control(true);
  assert.equal(h.posted.length, 1);
  h.control(true);
  assert.equal(h.posted.length, 1);
});

test("startup captures from a previous SPA page are discarded", async () => {
  const h = harness();
  await h.window.fetch("https://video.example/subtitles/early.vtt");
  await flush();
  h.location.href = "https://tv.apple.com/us/sporting-event/second";
  h.control(true);
  assert.equal(h.posted.length, 0);
});

test("unrelated fetch/XHR responses are not inspected, even if their text resembles captions", async () => {
  const { resp, state } = response(VTT, { url: "https://video.example/api/player", type: "application/json" });
  const h = harness({ fetch: async () => resp });
  h.control(true);
  await h.window.fetch(resp.url);
  const xhr = new h.FakeXHR();
  xhr.contentType = "application/json";
  xhr.responseText = VTT;
  xhr.open("GET", "https://video.example/api/player");
  xhr.send();
  xhr.load();
  await flush();
  assert.equal(state.clones, 0);
  assert.equal(h.posted.length, 0);
});

test("subtitle-looking URLs with unrelated bodies do not emit captions", async () => {
  const h = harness({ fetch: async () => response('{"status":"ok"}', { type: "application/json" }).resp });
  h.control(true);
  await h.window.fetch("https://video.example/subtitle-status");
  await flush();
  assert.equal(h.posted.length, 0);
});

test("declared oversize response is not cloned and oversized streams are cancelled", async () => {
  const largeHeader = response(VTT, { contentLength: 8 * 1024 * 1024 + 1 });
  const h = harness({ fetch: async () => largeHeader.resp });
  h.control(true);
  await h.window.fetch(largeHeader.resp.url);
  await flush();
  assert.equal(largeHeader.state.clones, 0);
  const largeStream = response("", { contentLength: 0, chunks: [new Uint8Array(8 * 1024 * 1024 + 1)] });
  const h2 = harness({ fetch: async () => largeStream.resp });
  h2.control(true);
  await h2.window.fetch(largeStream.resp.url);
  await flush();
  assert.equal(largeStream.state.cancelled, 1);
  assert.equal(largeStream.state.released, 1);
  assert.equal(h2.posted.length, 0);
});

test("MSE capture forwards timestampOffset, preserves buffer view bounds, and original append return", () => {
  const parsed = { cues: [{ start: 1, end: 3, text: "Native timeline" }], ttml: [], tracks: [{ codec: "wvtt" }] };
  const h = harness({ parse: () => parsed });
  h.control(true);
  const sb = new h.FakeSourceBuffer();
  sb.timestampOffset = -6.5;
  const backing = new Uint8Array([99, 99, 0, 0, 0, 8, 109, 111, 111, 102, 99]);
  const view = backing.subarray(2, 10);
  assert.equal(sb.appendBuffer(view), "append-result");
  assert.equal(sb.appends[0], view);
  assert.deepEqual(Array.from(h.parseCalls[0]), Array.from(view));
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].data.timeAligned, true);
  assert.equal(h.posted[0].data.offset, -6.5);
  assert.equal(h.posted[0].data.cues[0].text, "Native timeline");
});

test("original MSE append errors propagate unchanged and parser errors never break successful append", () => {
  const h = harness({ parse: () => { throw new Error("parser failure"); } });
  h.control(true);
  const sb = new h.FakeSourceBuffer();
  const error = new Error("InvalidStateError");
  sb.appendError = error;
  assert.throws(() => sb.appendBuffer(bytes("fragment")), err => err === error);
  assert.equal(h.parseCalls.length, 0);
  sb.appendError = null;
  assert.equal(sb.appendBuffer(bytes("fragment")), "append-result");
  assert.equal(h.parseCalls.length, 1);
  assert.equal(h.posted.length, 0);
});

test("MSE emits nothing after explicit disable", () => {
  const h = harness({ parse: () => ({ cues: [{ start: 1, end: 2, text: "No" }], ttml: [], tracks: [] }) });
  h.control(false);
  const sb = new h.FakeSourceBuffer();
  assert.equal(sb.appendBuffer(bytes("fragment")), "append-result");
  assert.equal(h.posted.length, 0);
});

test("fetch responses begun on a previous SPA page cannot be labeled as current captions", async () => {
  let resolveResponse;
  const responsePromise = new Promise(resolve => { resolveResponse = resolve; });
  const h = harness({ fetch: () => responsePromise });
  h.control(true);
  const pending = h.window.fetch("https://video.example/subtitles/old.vtt");
  h.location.href = "https://tv.apple.com/us/sporting-event/second";
  h.control(true);
  resolveResponse(response().resp);
  await pending;
  await flush();
  assert.equal(h.posted.length, 0);
});

test("XHR started on a previous SPA page cannot emit captions after navigation", () => {
  const h = harness();
  h.control(true);
  const xhr = new h.FakeXHR();
  xhr.open("GET", "https://video.example/subtitles/old.vtt");
  xhr.send();
  h.location.href = "https://tv.apple.com/us/sporting-event/second";
  h.control(true);
  xhr.responseText = VTT;
  xhr.load();
  assert.equal(h.posted.length, 0);
});

test("XHR blob decoding begun before navigation cannot publish into the next page", async () => {
  let resolveBlob;
  const blobData = new Promise(resolve => { resolveBlob = resolve; });
  const h = harness();
  h.control(true);
  const xhr = new h.FakeXHR();
  xhr.open("GET", "https://video.example/subtitles/old.vtt");
  xhr.send();
  xhr.responseType = "blob";
  xhr.response = { size: VTT.length, arrayBuffer: () => blobData };
  xhr.load();
  h.location.href = "https://tv.apple.com/us/sporting-event/second";
  h.control(true);
  resolveBlob(bytes(VTT).buffer);
  await flush();
  assert.equal(h.posted.length, 0);
});

test("a fetch clone stream finishing after navigation cannot publish stale captions", async () => {
  let resolveChunk;
  const pendingChunk = new Promise(resolve => { resolveChunk = resolve; });
  const { resp } = response();
  resp.clone = () => ({ body: { getReader() {
    let first = true;
    return {
      read() { if (first) { first = false; return pendingChunk; } return Promise.resolve({ done: true }); },
      releaseLock() {}, async cancel() {},
    };
  } } });
  const h = harness({ fetch: async () => resp });
  h.control(true);
  await h.window.fetch(resp.url);
  h.location.href = "https://tv.apple.com/us/sporting-event/second";
  h.control(true);
  resolveChunk({ done: false, value: bytes(VTT) });
  await flush();
  assert.equal(h.posted.length, 0);
});
