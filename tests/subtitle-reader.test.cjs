const test = require("node:test");
const assert = require("node:assert/strict");
const { readNative, isSubtitleElement } = require("../subtitle-reader.js");

function cue(text, startTime = 1, endTime = 3) { return { text, startTime, endTime }; }
function track(overrides = {}) {
  return { kind: "subtitles", mode: "showing", language: "en", activeCues: [], cues: [], ...overrides };
}
function video(tracks, currentTime = 2) { return { textTracks: tracks, currentTime }; }
function element(tagName = "DIV", attrs = {}, parentElement = null) {
  return {
    nodeType: 1, tagName, id: attrs.id || "", className: attrs.class || "", parentElement,
    getAttribute(name) { return attrs[name] || null; },
  };
}

test("only selected showing subtitle/caption tracks count; never changes track modes", () => {
  const tracks = [track({ mode: "hidden", activeCues: [cue("Hidden")] }),
    track({ mode: "disabled", activeCues: [cue("Disabled")] }),
    track({ kind: "metadata", activeCues: [cue("Metadata")] })];
  for (const t of tracks) {
    const mode = t.mode;
    Object.defineProperty(t, "mode", { get: () => mode, set: () => { throw new Error("must not mutate"); } });
  }
  assert.deepEqual(readNative(video(tracks)), { available: false, text: "", language: "" });
  assert.deepEqual(readNative(video([track({ kind: "captions", activeCues: [cue("Hello")] })])),
    { available: true, text: "Hello", language: "en" });
});

test("cue gaps still report an available selected track", () => {
  assert.deepEqual(readNative(video([track()])), { available: true, text: "", language: "en" });
  assert.deepEqual(readNative(null), { available: false, text: "", language: "" });
});

test("uses native cue HTML textContent without treating text as HTML again", () => {
  const c = cue("wrong fallback");
  c.getCueAsHTML = () => ({ textContent: "  Hello & <world> \n  Again\t now " });
  assert.equal(readNative(video([track({ activeCues: [c] })])).text, "Hello & <world>\nAgain now");
});

test("fallback cleans WebVTT voices, class tags, timestamps, entities and line endings", () => {
  const c = cue('<v Alex><c.yellow>Hello &amp; &lt;world&gt; &#x1f3ce;</c> <00:00:02.000>now<br>Next&#33;</v>\r\n ');
  c.getCueAsHTML = () => { throw new Error("unavailable"); };
  assert.equal(readNative(video([track({ activeCues: [c] })])).text, "Hello & <world> 🏎 now\nNext!");
});

test("cue start is inclusive, end is exclusive, and stale activeCues fall back after seeking", () => {
  const t = track({ activeCues: [cue("Old", 0, 2)], cues: [cue("Old", 0, 2), cue("New", 2, 4)] });
  assert.equal(readNative(video([t], 2)).text, "New");
  assert.equal(readNative(video([t], 4)).text, "");
  assert.equal(readNative(video([t], 1)).text, "Old");
});

test("combines and deduplicates overlapping cues, including duplicate showing tracks", () => {
  const t = track({ activeCues: [cue("First"), cue("Second"), cue("First")] });
  assert.equal(readNative(video([t, track({ activeCues: [cue("Second")] })])).text, "First\nSecond");
});

test("array-like TextTrack and TextTrackCue lists work without iterators", () => {
  const t = track({ activeCues: null, cues: { 0: cue("Fallback"), length: 1 } });
  assert.equal(readNative(video({ 0: t, length: 1 })).text, "Fallback");
});

test("unreadable tracks, malformed times and metadata are harmless", () => {
  const broken = { get mode() { throw new Error("detached"); } };
  const t = track({ activeCues: [cue("NaN", NaN, 3), cue("reverse", 4, 1), cue("good")] });
  assert.equal(readNative(video([broken, t])).text, "good");
  assert.deepEqual(readNative(video([t], NaN)), { available: true, text: "", language: "en" });
  assert.deepEqual(readNative({ get textTracks() { throw new Error("inaccessible"); } }),
    { available: false, text: "", language: "" });
});

test("actual subtitle renderers are accepted even with subtitle/caption classes", () => {
  const player = element("DIV", { role: "region", class: "video-player", tabindex: "0" });
  const captions = element("DIV", { class: "video-player__captions subtitle-container" }, player);
  assert.equal(isSubtitleElement(element("SPAN", { class: "caption-text" }, captions)), true);
  assert.equal(isSubtitleElement(element("DIV", { role: "status", class: "subtitles" })), true);
});

test("translation overlay is excluded by ancestor id or class to prevent feedback loops", () => {
  const root = element("DIV", { id: "llm-subtitle-overlay" });
  assert.equal(isSubtitleElement(element("SPAN", { class: "subtitle" }, root)), false);
  assert.equal(isSubtitleElement(element("SPAN", { class: "other llm-subtitle-translated" })), false);
});

test("interactive controls and menus cannot be mistaken for captions", () => {
  for (const host of [element("BUTTON"), element("AMP-CAPTIONS-CONTROL"),
    element("DIV", { class: "video-player__control--captions" }),
    element("DIV", { class: "video-player__controls" }), element("DIV", { role: "menu" }),
    element("DIV", { role: "menuitemradio" })]) {
    assert.equal(isSubtitleElement(element("SPAN", { class: "subtitle-label" }, host)), false);
  }
  assert.equal(isSubtitleElement(element("DIV", { class: "video-player__controller-caption" })), true);
});

test("exclusions follow shadow-root hosts, including multiple shadow boundaries", () => {
  const overlay = element("DIV", { id: "llm-subtitle-overlay" });
  const innerHost = element("CUSTOM-CAPTIONS");
  innerHost.getRootNode = () => ({ host: overlay });
  const text = element("SPAN", { class: "subtitle" });
  text.parentNode = { host: innerHost };
  assert.equal(isSubtitleElement(text), false);
  const controlText = element("SPAN");
  controlText.getRootNode = () => ({ host: element("AMP-CAPTIONS-CONTROL") });
  assert.equal(isSubtitleElement(controlText), false);
});

test("null/non-element input and cyclic mock ancestors are safe", () => {
  assert.equal(isSubtitleElement(null), false);
  assert.equal(isSubtitleElement({ nodeType: 3 }), false);
  const el = element();
  el.parentElement = el;
  assert.equal(isSubtitleElement(el), true);
});
