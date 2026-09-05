"use strict";

// Integration-level harness: execute the actual content script unchanged.
// Minimal DOM/Chrome fakes model the overlay, TextTracks, capture bridge and
// asynchronous translation callbacks. No network or browser credentials.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Reader = require("../subtitle-reader.js");
const TranslationContext = require("../translation-context.js");
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

const videoRect = { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 };
const cueRect = { left: 400, top: 850, right: 1500, bottom: 960, width: 1100, height: 110 };

class Element {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = [];
    this.id = attrs.id || ""; this.className = attrs.class || "";
    this.attrs = attrs; this.style = { setProperty(name, value) { this[name] = value; } };
    this.textContent = ""; this.parentElement = null;
  }
  appendChild(child) {
    child.remove(); this.children.push(child); child.parentElement = this; return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  get isConnected() { return this.tagName === "HTML" || !!this.parentElement?.isConnected; }
  get childNodes() { return this.children; }
  get parentNode() { return this.parentElement; }
  get innerText() { return this.textContent; }
  set innerHTML(value) {
    this.children = [];
    if (value.includes("llm-subtitle-translated")) {
      this.appendChild(new Element("div", { class: "llm-subtitle-translated" }));
      this.appendChild(new Element("div", { class: "llm-subtitle-original" }));
    }
  }
  getAttribute(name) { return this.attrs[name] || null; }
  getBoundingClientRect() { return this.tagName === "VIDEO" ? videoRect : cueRect; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  querySelectorAll(selector) {
    const selectors = selector.split(/,\s*/);
    const matches = (el) => selectors.some(sel => {
      if (sel.startsWith("#")) return el.id === sel.slice(1);
      if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
      const partial = sel.match(/^\[class\*=['"]([^'"]+)['"]\]$/);
      return partial ? el.className.includes(partial[1]) : el.tagName.toLowerCase() === sel;
    });
    const out = [];
    const walk = (el) => { for (const child of el.children) { if (matches(child)) out.push(child); walk(child); } };
    walk(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

async function harness({ enabled = true, cues = [], time = 10, autoResponse = false, dialogOpen = false, showOriginal = false, youtube = false, channel = false, title = "", translationMode = "auto", f1ContextLines = 4 } = {}) {
  let now = 10000, nextTimer = 1;
  const intervals = new Map(), timeouts = new Map(), listeners = new Map();
  const requests = [], logs = [], storageListeners = [];
  let settings = { enabled, showOriginal, contextLines: 0, skipLanguages: [], fontSize: 32, translationMode, f1ContextLines };
  const html = new Element("html"), body = new Element("body"), player = new Element("div");
  const video = new Element("video");
  const track = { mode: "showing", kind: "captions", language: "en", cues, activeCues: [] };
  Object.assign(video, { currentTime: time, paused: false, readyState: 4, textTracks: [track] });
  html.appendChild(body); body.appendChild(player); player.appendChild(video);
  const dialog = new Element("dialog", { class: "playback-view" });
  dialog.open = false;
  function openDialog() {
    dialog.open = true;
    const outer = new Element("div"), inner = new Element("div");
    body.appendChild(dialog); dialog.appendChild(outer); outer.appendChild(inner); inner.appendChild(player);
  }
  if (dialogOpen) openDialog();
  const document = {
    nodeType: 9, children: [html], documentElement: html, body, title,
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    getElementById: (id) => html.querySelector("#" + id),
    createElement: (tag) => new Element(tag), addEventListener() {},
  };
  const location = { href: "https://tv.apple.com/us/sporting-event/test", pathname: "/us/sporting-event/test", hostname: "tv.apple.com", origin: "https://tv.apple.com" };
  if (channel) Object.assign(location, { href: "https://tv.apple.com/us/channel/formula-1/test", pathname: "/us/channel/formula-1/test" });
  if (youtube) Object.assign(location, { href: "https://www.youtube.com/watch?v=test", pathname: "/watch", hostname: "www.youtube.com", origin: "https://www.youtube.com" });
  const context = {
    document, location, LLMSubtitleReader: Reader, LLMTranslationContext: TranslationContext, innerWidth: 1920, innerHeight: 1080,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", fontSize: "32px" }),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage() {},
    setInterval(fn, delay) { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, delay) { const id = nextTimer++; timeouts.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    chrome: {
      runtime: {
        getURL: file => "chrome-extension://test/" + file,
        sendMessage(message, callback) {
          if (message.type === "getSettings") { callback({ ...settings }); return; }
          if (message.type !== "translate") throw new Error("Unexpected message");
          requests.push({ message, callback });
          if (autoResponse) queueMicrotask(() => callback({ ok: true, translations: ["中文：" + message.lines[0]] }));
        },
      },
      storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    },
  };
  context.window = context; context.top = context; context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "content.js" });
  await flush();
  return {
    video, track, player, html, requests, logs, dialog, openDialog,
    overlay() { return html.querySelector("#llm-subtitle-overlay"); },
    translated() { return this.overlay()?.querySelector(".llm-subtitle-translated")?.textContent || ""; },
    async poll(ms = 100) {
      now += ms;
      for (const [id, timer] of [...timeouts]) if (timer.at <= now) { timeouts.delete(id); timer.fn(); }
      for (const timer of [...intervals.values()]) if (timer.delay === 100 || timer.delay === 200) timer.fn();
      await flush();
    },
    async retry(ms = 5000) {
      now += ms;
      for (const timer of [...intervals.values()]) if (timer.delay === 5000) timer.fn();
      await flush();
    },
    async lifecycle() {
      now += 1000;
      for (const timer of [...intervals.values()]) if (timer.delay === 1000) timer.fn();
      await flush();
    },
    async respond(index, translation = "中文", ok = true) {
      requests[index].callback(ok ? { ok: true, translations: [translation] } : { ok: false, error: "test failure" });
      await flush();
    },
    async capture(capture) {
      const event = { source: context, origin: location.origin,
        data: { source: "__llm-subtitle-capture", page: location.href, ...capture } };
      // In a VM, window is a contextified proxy rather than the original object.
      context.__testEvent = event;
      vm.runInContext("__testEvent.source = window", context);
      for (const fn of listeners.get("message") || []) fn(event);
      await flush();
    },
    async enable(value) {
      settings = { ...settings, enabled: value };
      for (const fn of storageListeners) fn({ enabled: { newValue: value } }, "sync");
      await flush();
    },
  };
}

const nativeCue = (text, startTime = 10, endTime = 12) => ({ text, startTime, endTime });

test("F1 uses preceding source cues and shares the current prefetch request", async () => {
  const h = await harness({ title: "F1 Italy Practice", cues: [
    nativeCue("First source", 6, 8), nativeCue("Second source", 8, 10),
    nativeCue("Current source", 10, 12), nativeCue("Future source", 12, 14),
  ] });
  assert.equal(h.requests.length, 2);
  const current = h.requests.find(r => r.message.lines[0] === "Current source").message;
  assert.equal(current.translationProfile, "f1");
  assert.deepEqual(Array.from(current.sourceContext), ["First source", "Second source"]);
  assert.equal(current.history.length, 0);
  await h.respond(1, "未来译文");
  await h.respond(0, "当前译文");
  h.video.currentTime = 12.5;
  await h.poll(1000);
  assert.equal(h.requests.length, 2, "source order is independent of response completion order");
  assert.equal(h.translated(), "未来译文");
});

test("F1 context resets across track changes and off mode keeps ordinary behavior", async () => {
  const h = await harness({ title: "F1", cues: [nativeCue("Old English", 8, 10), nativeCue("Now", 10, 12)] });
  h.track.language = "es";
  h.track.cues = [nativeCue("Nuevo", 10, 12)];
  await h.poll(1000);
  assert.deepEqual(Array.from(h.requests.at(-1).message.sourceContext), []);
  const off = await harness({ title: "F1", translationMode: "off", cues: [nativeCue("Now")] });
  assert.equal(off.requests[0].message.translationProfile, "general");
});

test("channel-page live modal starts translation and stops when closed without URL navigation", async () => {
  const h = await harness({ channel: true, cues: [nativeCue("Live English CC")] });
  assert.equal(h.requests.length, 0, "channel previews do not trigger translation");
  h.openDialog();
  await h.lifecycle();
  assert.equal(h.requests.length, 1, "opening the live player activates native captions");
  await h.respond(0, "直播中文字幕");
  assert.equal(h.translated(), "直播中文字幕");
  assert.equal(h.overlay().parentElement, h.dialog);
  h.dialog.open = false;
  await h.lifecycle();
  assert.equal(h.overlay().style.display, "none");
  h.track.cues.push(nativeCue("After player closed"));
  await h.poll();
  assert.equal(h.requests.length, 1, "closed player sends no further requests");
});

test("live player open at load handles native captions arriving later", async () => {
  const h = await harness({ channel: true, dialogOpen: true, time: 1000 });
  assert.equal(h.requests.length, 0);
  h.track.cues.push(nativeCue("New live segment", 1000, 1003));
  await h.poll(1000);
  assert.equal(h.requests.length, 1);
  await h.respond(0, "新直播字幕");
  assert.equal(h.translated(), "新直播字幕");
});
const vtt = (text) => "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\n" + text + "\n";

test("native cue requests one translation shared by prefetch and visible overlay", async () => {
  const h = await harness({ cues: [nativeCue("Native English")] });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].message.lines[0], "Native English");
  await h.respond(0, "原生字幕翻译");
  assert.equal(h.translated(), "原生字幕翻译");
  assert.equal(h.overlay().style.display, "flex");
  assert.equal(h.html.querySelector("#llm-subtitle-hide-native"), null, "Apple captions remain visible");
});

test("selected native track gap clears display and late translation cannot resurrect it", async () => {
  const h = await harness({ cues: [nativeCue("Ending soon")] });
  h.video.currentTime = 13;
  await h.poll();
  await h.respond(0, "迟到的翻译");
  assert.equal(h.translated(), "");
  assert.equal(h.overlay().style.display, "none");
});

test("turning the selected track off clears a previously visible translation", async () => {
  const h = await harness({ cues: [nativeCue("Turn off")] });
  await h.respond(0, "关闭前字幕");
  assert.equal(h.overlay().style.display, "flex");
  h.track.mode = "disabled";
  await h.poll();
  assert.equal(h.overlay().style.display, "none");
});

test("Apple TV ignores unselected network subtitles instead of displaying or translating them", async () => {
  const h = await harness();
  await h.capture({ text: vtt("Unselected language"), url: "https://example.test/es.vtt" });
  await h.poll();
  assert.equal(h.requests.length, 0);
  assert.equal(h.overlay().style.display, "none");
});

test("disabled extension does not translate captures or revive in-flight results", async () => {
  const disabled = await harness({ enabled: false });
  await disabled.capture({ text: vtt("disabled") });
  assert.equal(disabled.requests.length, 0);
  const running = await harness({ cues: [nativeCue("Will disable")] });
  assert.equal(running.requests.length, 1);
  await running.enable(false);
  await running.respond(0, "不能出现");
  assert.equal(running.overlay().style.display, "none");
  assert.notEqual(running.translated(), "不能出现");
});

test("prefetch is limited to 30 seconds ahead; failures wait for retry without a tight loop", async () => {
  const h = await harness({ cues: [nativeCue("near", 11, 13), nativeCue("too far", 41, 43)] });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].message.lines[0], "near");
  await h.respond(0, "", false);
  assert.equal(h.requests.length, 1, "failure does not spin");
  await h.retry(5000);
  assert.equal(h.requests.length, 1, "five seconds is still inside backoff");
  await h.retry(10000);
  assert.equal(h.requests.length, 2, "one retry when backoff expires");
  assert.equal(h.requests[1].message.lines[0], "near");
  await h.respond(1, "重试成功");
  await h.retry(15000);
  assert.equal(h.requests.length, 2, "success is cached; far-future subtitle still excluded");
});

test("caption-like menu nodes and the extension's own overlay are never translated", async () => {
  const h = await harness();
  h.track.mode = "disabled"; // Exercise DOM fallback, not the native cue-gap path.
  const menu = new Element("div", { class: "subtitle-menu", role: "menu" });
  menu.textContent = "Subtitles On Off English CC";
  h.player.appendChild(menu);
  h.overlay().querySelector(".llm-subtitle-translated").textContent = "old overlay text";
  await h.poll();
  assert.equal(h.requests.length, 0);
});

test("Apple TV native subtitle overlay is mounted inside the open player dialog", async () => {
  const h = await harness({ cues: [nativeCue("Dialog subtitle")], dialogOpen: true });
  await h.respond(0, "弹窗内中文字幕");
  assert.equal(h.translated(), "弹窗内中文字幕");
  assert.equal(h.overlay().parentElement, h.dialog,
    "HTML siblings cannot paint above a modal dialog in the browser top layer");
  assert.equal(h.html.querySelectorAll("#llm-subtitle-overlay").length, 1);
});

test("opening a player dialog rehomes an existing unchanged cue on the next poll", async () => {
  const h = await harness({ cues: [nativeCue("Already visible")] });
  await h.respond(0, "已显示的字幕");
  const oldOverlay = h.overlay();
  assert.equal(oldOverlay.parentElement, h.html);
  h.openDialog();
  await h.poll();
  assert.equal(h.overlay().parentElement, h.dialog);
  assert.equal(h.translated(), "已显示的字幕", "rehome preserves the current translation");
  assert.equal(h.html.querySelectorAll("#llm-subtitle-overlay").length, 1, "no stacked orphan overlay");
  assert.equal(h.requests.length, 1, "rehome does not retransmit a subtitle");
});

test("Apple native English suppresses the duplicate original row while DOM-only originals remain available", async () => {
  const native = await harness({ cues: [nativeCue("Visible native English")], showOriginal: true });
  await native.respond(0, "保留中文字幕");
  assert.equal(native.overlay().querySelector(".llm-subtitle-original").style.display, "none");
  assert.equal(native.translated(), "保留中文字幕");
  assert.equal(native.overlay().style.display, "flex");

  const dom = await harness({ showOriginal: true });
  dom.track.mode = "disabled";
  const caption = new Element("div", { class: "subtitle-renderer" });
  caption.textContent = "DOM-only English";
  dom.player.appendChild(caption);
  await dom.poll();
  await dom.respond(0, "DOM字幕翻译");
  assert.equal(dom.overlay().querySelector(".llm-subtitle-original").style.display, "block");
  assert.equal(dom.overlay().querySelector(".llm-subtitle-original").textContent, "DOM-only English");
  assert.equal(dom.translated(), "DOM字幕翻译");
  assert.equal(dom.overlay().style.display, "flex");
});

test("YouTube retains DOM detection and legacy timedtext cache warming", async () => {
  const h = await harness({ youtube: true, cues: [nativeCue("Do not switch YouTube to native detection")] });
  assert.equal(h.requests.length, 0);
  await h.capture({ text: vtt("&gt;&gt; YouTube subtitle"), url: "https://www.youtube.com/api/timedtext?lang=en" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].message.lines[0], ">> YouTube subtitle");
  await h.respond(0, "YouTube字幕");
  const caption = new Element("div", { class: "ytp-caption-window-container" });
  caption.textContent = ">> YouTube subtitle";
  h.player.appendChild(caption);
  await h.poll();
  assert.equal(h.translated(), "YouTube字幕");
  assert.equal(h.requests.length, 1, "network and visible text share the same cache");
});
