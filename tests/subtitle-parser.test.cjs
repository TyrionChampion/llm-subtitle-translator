"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createParser, LIMITS } = require("../subtitle-parser.js");

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; };
const i32 = (value) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const join = (...parts) => Buffer.concat(parts);
const box = (type, ...parts) => { const body = join(...parts); return join(u32(body.length + 8), Buffer.from(type), body); };
const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);
const cue = (text) => box("vttc", box("payl", Buffer.from(text)));

function init({ codec = "wvtt", id = 7, timescale = 1000, defaultDuration = 0,
  defaultSize = 0, extra = Buffer.alloc(0), version = 0, language = "eng" } = {}) {
  const long = version ? Buffer.alloc(16) : Buffer.alloc(8);
  const tkhd = full("tkhd", version, 0, long, u32(id), Buffer.alloc(64));
  const codes = [...language].map((char) => char.charCodeAt(0) - 0x60);
  const packedLanguage = Buffer.alloc(2);
  packedLanguage.writeUInt16BE((codes[0] << 10) | (codes[1] << 5) | codes[2]);
  const mdhd = full("mdhd", version, 0, long, u32(timescale), Buffer.alloc(version ? 8 : 4), packedLanguage, Buffer.alloc(2));
  const strings = codec === "stpp" ? Buffer.from("http://www.w3.org/ns/ttml\0\0\0") : Buffer.alloc(0);
  const entry = box(codec, join(Buffer.alloc(6), Buffer.from([0, 1])), strings, extra);
  const stsd = full("stsd", 0, 0, u32(1), entry);
  const track = box("trak", tkhd, box("mdia", mdhd, box("minf", box("stbl", stsd))));
  const trex = full("trex", 0, 0, u32(id), u32(1), u32(defaultDuration), u32(defaultSize), u32(0));
  return box("moov", track, box("mvex", trex));
}

function fragment(samples, { id = 7, time = 12000, defaults = false, tfhdDefaults = false,
  compositionOffsets = null, time64 = false, extra = Buffer.alloc(0), sizeOverride = null,
  offsetDelta = 0 } = {}) {
  const flags = 0x020000 | (tfhdDefaults ? 0x18 : 0);
  const tfhd = full("tfhd", 0, flags, u32(id), ...(tfhdDefaults ? [u32(2000), u32(samples[0].length)] : []));
  const tfdt = full("tfdt", time64 ? 1 : 0, 0, time64 ? u64(time) : u32(time));
  const runFlags = 1 | (defaults ? 0 : 0x300) | (compositionOffsets ? 0x800 : 0);
  const fields = [];
  samples.forEach((sample, index) => {
    if (!defaults) fields.push(u32(2000), u32(sizeOverride ?? sample.length));
    if (compositionOffsets) fields.push(i32(compositionOffsets[index]));
  });
  const makeMoof = (offset) => box("moof", box("traf", tfhd, tfdt,
    full("trun", compositionOffsets ? 1 : 0, runFlags, u32(samples.length), i32(offset), ...fields), extra));
  const provisional = makeMoof(0);
  return join(makeMoof(provisional.length + 8 + offsetDelta), box("mdat", ...samples));
}

test("classic-script global matches CommonJS API", () => {
  assert.equal(globalThis.LLMSubtitleParser.createParser, createParser);
});

test("initialization metadata plus WVTT produces UTF-8, timed plain text", () => {
  const parser = createParser();
  assert.deepEqual(parser.parse(init()).tracks, [{ id: 7, timescale: 1000, codec: "wvtt", language: "eng" }]);
  const sample = cue("<v Driver><b>Hello &amp; 你好</b><br>Lap &#49;</v>");
  assert.deepEqual(parser.parse(fragment([sample])).cues,
    [{ start: 12, end: 14, text: "Hello & 你好\nLap 1", trackId: 7, language: "eng" }]);
});

test("multiple cues in one sample, empty samples, sequential timestamps", () => {
  const parser = createParser(); parser.parse(init());
  const output = parser.parse(fragment([join(cue("one"), cue("two")), box("vtte"), cue("three")]));
  assert.equal(output.rejected, false);
  assert.deepEqual(output.cues, [
    { start: 12, end: 14, text: "one", trackId: 7, language: "eng" }, { start: 12, end: 14, text: "two", trackId: 7, language: "eng" },
    { start: 16, end: 18, text: "three", trackId: 7, language: "eng" },
  ]);
});

test("trex and tfhd duration/size defaults, 64-bit decode times", () => {
  const sample = cue("defaults");
  for (const tfhdDefaults of [false, true]) {
    const parser = createParser();
    parser.parse(init({ version: 1, defaultDuration: tfhdDefaults ? 0 : 2000, defaultSize: tfhdDefaults ? 0 : sample.length }));
    const result = parser.parse(fragment([sample], { defaults: true, tfhdDefaults, time64: true, time: 0x100000000 }));
    assert.equal(result.rejected, false);
    assert.equal(result.cues[0].start, 0x100000000 / 1000);
    assert.equal(result.cues[0].end, (0x100000000 + 2000) / 1000);
  }
});

test("signed composition offset applies to each sample's decode time", () => {
  const parser = createParser(); parser.parse(init());
  assert.deepEqual(parser.parse(fragment([cue("a"), cue("b")], { compositionOffsets: [-500, 250] })).cues,
    [{ start: 11.5, end: 13.5, text: "a", trackId: 7, language: "eng" }, { start: 14.25, end: 16.25, text: "b", trackId: 7, language: "eng" }]);
});

test("STPP extracts a clear TTML document and sample timing without evaluating XML", () => {
  const parser = createParser(); parser.parse(init({ codec: "stpp" }));
  const xml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="12s" end="14s">Hello</p></div></body></tt>';
  const result = parser.parse(fragment([Buffer.from(xml)]));
  assert.equal(result.rejected, false);
  assert.deepEqual(result.ttml, [{ xml, start: 12, end: 14, trackId: 7, language: "eng" }]);
  assert.deepEqual(result.cues, []);
});

test("STPP rejects entity declarations and non-TTML payloads", () => {
  for (const sample of ["<!DOCTYPE tt [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><tt/>", "not XML", "<html><body>wrong</body></html>"]) {
    const parser = createParser(); parser.parse(init({ codec: "stpp" }));
    assert.equal(parser.parse(fragment([Buffer.from(sample)])).rejected, true);
  }
});

test("encrypted sample entry and protected subtitle fragments never produce text", () => {
  for (const metadata of [init({ codec: "enct" }), init({ extra: box("sinf", box("schi", box("tenc", Buffer.alloc(24)))) })]) {
    const parser = createParser();
    assert.deepEqual(parser.parse(metadata).tracks, []);
    assert.deepEqual(parser.parse(fragment([cue("must not leak")])).cues, []);
  }
  for (const extra of [full("senc", 0, 0, u32(0)), box("saiz", Buffer.alloc(8)), box("uuid", Buffer.alloc(16)), full("sgpd", 1, 0, Buffer.from("seig"), u32(0))]) {
    const parser = createParser(); parser.parse(init());
    const result = parser.parse(fragment([cue("must not leak")], { extra }));
    assert.deepEqual(result.cues, []);
    assert.match(result.warnings.join(" "), /Protected/);
  }
});

test("no init, wrong track ID and reset do not guess a codec or timescale", () => {
  const parser = createParser();
  assert.deepEqual(parser.parse(fragment([cue("no init")])).cues, []);
  parser.parse(init());
  assert.deepEqual(parser.parse(fragment([cue("wrong ID")], { id: 8 })).cues, []);
  parser.reset();
  assert.deepEqual(parser.parse(fragment([cue("reset")])).cues, []);
});

test("truncation, out-of-range data offsets and sample sizes reject transactionally", () => {
  const valid = fragment([cue("a"), cue("b")]);
  const invalid = [
    valid.subarray(0, valid.length - 1),
    fragment([cue("a")], { offsetDelta: -4 }),
    fragment([cue("a")], { offsetDelta: 10000 }),
    fragment([cue("a")], { sizeOverride: 999999 }),
    box("moof", box("traf", full("tfhd", 0, 0, u32(7)), full("trun", 0, 0, u32(0)))),
    join(u32(3), Buffer.from("mdat")),
    join(u32(1), Buffer.from("mdat"), u64(2n ** 60n)),
  ];
  for (const data of invalid) {
    const parser = createParser(); parser.parse(init());
    const result = parser.parse(data);
    assert.equal(result.rejected, true, result.warnings.join(" "));
    assert.deepEqual(result.cues, []);
  }
});

test("oversize and invalid input rejected, valid subarray with byteOffset accepted", () => {
  const parser = createParser(); parser.parse(init());
  for (const input of [new Uint8Array(LIMITS.segmentBytes + 1), new Uint8Array(0), "oops"]) {
    assert.equal(parser.parse(input).rejected, true);
  }
  const valid = fragment([cue("view")]);
  const wrapped = join(Buffer.from("prefix"), valid, Buffer.from("suffix"));
  assert.equal(parser.parse(wrapped.subarray(6, 6 + valid.length)).cues[0].text, "view");
});

test("an invalid subsequent init does not poison validated track metadata", () => {
  const parser = createParser(); parser.parse(init());
  assert.equal(parser.parse(init({ timescale: 0 })).rejected, true);
  assert.equal(parser.parse(fragment([cue("still works")])).cues[0].text, "still works");
});

test("combined init plus media resolves moof-relative offsets, language follows new init", () => {
  const parser = createParser();
  const english = parser.parse(join(init(), fragment([cue("English")])));
  assert.equal(english.cues[0].language, "eng");
  const spanish = parser.parse(join(init({ language: "spa", id: 4 }), fragment([cue("Español")], { id: 4 })));
  assert.equal(spanish.rejected, false);
  assert.equal(spanish.cues[0].language, "spa");
  assert.equal(spanish.cues[0].trackId, 4);
  assert.deepEqual(parser.parse(fragment([cue("stale track")])).cues, []);
});

test("subsequent trun without data_offset continues after previous run", () => {
  const parser = createParser(); parser.parse(init());
  const first = cue("first"), second = cue("second");
  const make = (offset) => box("moof", box("traf", full("tfhd", 0, 0x20000, u32(7)),
    full("tfdt", 0, 0, u32(1000)),
    full("trun", 0, 0x301, u32(1), i32(offset), u32(2000), u32(first.length)),
    full("trun", 0, 0x300, u32(1), u32(3000), u32(second.length))));
  const result = parser.parse(join(make(make(0).length + 8), box("mdat", first, second)));
  assert.equal(result.rejected, false);
  assert.deepEqual(result.cues.map(({ text, start, end }) => ({ text, start, end })),
    [{ text: "first", start: 1, end: 3 }, { text: "second", start: 3, end: 6 }]);
});

test("sample-count and timestamp precision limits reject without allocating huge arrays", () => {
  const parser = createParser(); parser.parse(init());
  const countBomb = box("moof", box("traf", full("tfhd", 0, 0x20000, u32(7)),
    full("tfdt", 0, 0, u32(0)), full("trun", 0, 0, u32(0xffffffff))));
  assert.match(parser.parse(countBomb).warnings.join(" "), /Too many subtitle samples/);
  assert.equal(parser.parse(fragment([cue("unsafe")], { time64: true, time: Number.MAX_SAFE_INTEGER })).rejected, true);
});

test("a failure in a later sample discards earlier partial cues", () => {
  const parser = createParser(); parser.parse(init());
  const result = parser.parse(fragment([cue("must not emit partial result"), join(u32(2), Buffer.from("vttc"))]));
  assert.equal(result.rejected, true);
  assert.deepEqual(result.cues, []);
});
