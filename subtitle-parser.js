// Bounded parser for clear, fragmented ISO BMFF subtitle tracks (wvtt/stpp).
// This deliberately does not inspect audio/video sample payloads or decrypt
// protected samples. Input must contain complete boxes (init then fragments).
// Returned times are media-track seconds, before SourceBuffer.timestampOffset.
// STPP returns XML separately so the existing browser TTML parser can apply
// document timing. It is never treated as HTML or evaluated here.
// Format references: https://www.w3.org/TR/mse-byte-stream-format-isobmff/
// and ISO/IEC 14496-12 / 14496-30 box layouts.
(function (root) {
  "use strict";

  const LIMITS = Object.freeze({
    segmentBytes: 8 * 1024 * 1024,
    sampleBytes: 256 * 1024,
    samples: 4096,
    boxes: 10000,
    tracks: 32,
  });
  const UTF8 = new TextDecoder("utf-8", { fatal: true });
  const ENCRYPTED_ENTRIES = new Set(["encs", "enct", "encv", "enca"]);
  const fail = (message) => { throw new Error(message); };

  function asBytes(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input instanceof Uint8Array) return input;
    fail("Expected ArrayBuffer or Uint8Array");
  }

  function reader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let boxCount = 0;
    function need(pos, count, end = bytes.length) {
      if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(count) ||
          pos < 0 || count < 0 || pos + count > end || end > bytes.length) {
        fail("Truncated or invalid MP4 data");
      }
    }
    function u16(pos, end) { need(pos, 2, end); return view.getUint16(pos); }
    function u32(pos, end) { need(pos, 4, end); return view.getUint32(pos); }
    function i32(pos, end) { need(pos, 4, end); return view.getInt32(pos); }
    function u64(pos, end) {
      const result = u32(pos, end) * 0x100000000 + u32(pos + 4, end);
      if (!Number.isSafeInteger(result)) fail("MP4 integer exceeds safe precision");
      return result;
    }
    function boxes(start, end) {
      need(start, end - start);
      const list = [];
      for (let pos = start; pos < end;) {
        if (++boxCount > LIMITS.boxes) fail("Too many MP4 boxes");
        need(pos, 8, end);
        let size = u32(pos, end);
        const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
        let header = 8;
        if (size === 1) { size = u64(pos + 8, end); header = 16; }
        else if (size === 0) size = end - pos;
        if (size < header) fail("Invalid MP4 box size");
        need(pos, size, end);
        list.push({ type, start: pos, data: pos + header, end: pos + size });
        pos += size;
      }
      return list;
    }
    const children = (box) => boxes(box.data, box.end);
    function full(box, versions = [0]) {
      need(box.data, 4, box.end);
      const version = bytes[box.data];
      if (!versions.includes(version)) fail("Unsupported " + box.type + " version");
      return { version, flags: u32(box.data, box.end) & 0xffffff, pos: box.data + 4 };
    }
    function one(list, type, required = true) {
      const found = list.filter((box) => box.type === type);
      if (found.length > 1 || (required && found.length !== 1)) fail("Missing/duplicate " + type);
      return found[0];
    }
    return { bytes, need, u16, u32, i32, u64, boxes, children, full, one };
  }

  function plainVtt(text) {
    return text.replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name])
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code) => {
        const value = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value) : whole;
      }).replace(/\r/g, "").trim();
  }

  function readInit(r, moov, warnings) {
    const children = r.children(moov);
    const traks = children.filter((b) => b.type === "trak");
    if (traks.length > LIMITS.tracks) fail("Too many MP4 tracks");
    const tracks = new Map();
    for (const trak of traks) {
      const parts = r.children(trak);
      const tkhd = r.one(parts, "tkhd");
      const header = r.full(tkhd, [0, 1]);
      const id = r.u32(header.pos + (header.version ? 16 : 8), tkhd.end);
      if (!id || tracks.has(id)) fail("Invalid/duplicate track ID");
      const mdia = r.one(parts, "mdia");
      const media = r.children(mdia);
      const mdhd = r.one(media, "mdhd");
      const md = r.full(mdhd, [0, 1]);
      const timescale = r.u32(md.pos + (md.version ? 16 : 8), mdhd.end);
      const packedLanguage = r.u16(md.pos + (md.version ? 28 : 16), mdhd.end);
      const languageCodes = [(packedLanguage >> 10) & 31, (packedLanguage >> 5) & 31, packedLanguage & 31];
      const language = languageCodes.every((code) => code >= 1 && code <= 26)
        ? String.fromCharCode(...languageCodes.map((code) => code + 0x60)) : "und";
      const minf = r.one(media, "minf");
      const stbl = r.one(r.children(minf), "stbl");
      const stsd = r.one(r.children(stbl), "stsd");
      const desc = r.full(stsd);
      const count = r.u32(desc.pos, stsd.end);
      const entries = r.boxes(desc.pos + 4, stsd.end);
      if (count !== entries.length) fail("Invalid sample description count");
      const record = { id, timescale, language, codec: null, encrypted: false, description: 1, duration: 0, size: 0 };
      tracks.set(id, record);
      if (entries.some((entry) => ENCRYPTED_ENTRIES.has(entry.type))) {
        record.encrypted = true;
        warnings.push("Protected track " + id + " skipped");
        continue;
      }
      const subtitle = entries.find((entry) => entry.type === "wvtt" || entry.type === "stpp");
      if (!subtitle) continue;
      if (entries.length !== 1) { warnings.push("Multiple subtitle sample descriptions unsupported"); continue; }
      if (!timescale) fail("Subtitle track has zero timescale");
      r.need(subtitle.data, 8, subtitle.end); // SampleEntry reserved + data_reference_index.
      let childStart = subtitle.data + 8;
      if (subtitle.type === "stpp") {
        // Three zero-terminated UTF-8 strings precede optional child boxes.
        for (let i = 0; i < 3; i++) {
          const zero = r.bytes.indexOf(0, childStart);
          if (zero < childStart || zero >= subtitle.end) fail("Invalid stpp sample entry strings");
          UTF8.decode(r.bytes.subarray(childStart, zero));
          childStart = zero + 1;
        }
      }
      const extra = r.boxes(childStart, subtitle.end);
      if (extra.some((b) => b.type === "sinf" || b.type === "tenc")) {
        record.encrypted = true;
        warnings.push("Protected subtitle track " + id + " skipped");
        continue;
      }
      // Edit lists need a movie/period timeline mapping. Refuse to guess.
      const edts = r.one(parts, "edts", false);
      if (edts && r.children(edts).some((b) => b.type === "elst")) {
        warnings.push("Subtitle edit list unsupported for track " + id);
        continue;
      }
      record.codec = subtitle.type;
    }
    const mvex = r.one(children, "mvex", false);
    if (mvex) {
      for (const box of r.children(mvex).filter((b) => b.type === "trex")) {
        const full = r.full(box);
        r.need(full.pos, 20, box.end);
        const track = tracks.get(r.u32(full.pos, box.end));
        if (track) {
          track.description = r.u32(full.pos + 4, box.end);
          track.duration = r.u32(full.pos + 8, box.end);
          track.size = r.u32(full.pos + 12, box.end);
        }
      }
    }
    return tracks;
  }

  function encryptedFragment(r, list) {
    if (list.some((b) => ["senc", "saiz", "saio", "uuid"].includes(b.type))) return true;
    // A seig sample group can signal per-sample encryption overrides.
    return list.some((b) => {
      if (b.type !== "sgpd" && b.type !== "sbgp") return false;
      r.need(b.data, 8, b.end);
      return String.fromCharCode(...r.bytes.subarray(b.data + 4, b.data + 8)) === "seig";
    });
  }

  function readFragment(r, moof, mdats, tracks, result, budget) {
    const trafs = r.children(moof).filter((b) => b.type === "traf");
    for (const traf of trafs) {
      const parts = r.children(traf);
      const tfhd = r.one(parts, "tfhd");
      const full = r.full(tfhd);
      const trackID = r.u32(full.pos, tfhd.end);
      const track = tracks.get(trackID);
      if (!track) { result.warnings.push("Missing init metadata for track " + trackID); continue; }
      if (track.encrypted || !track.codec) continue;
      if (encryptedFragment(r, parts)) {
        result.warnings.push("Protected/auxiliary subtitle fragment " + trackID + " skipped");
        continue;
      }
      let pos = full.pos + 4;
      let base = moof.start;
      let description = track.description;
      let defaultDuration = track.duration;
      let defaultSize = track.size;
      if (full.flags & 1) { base = r.u64(pos, tfhd.end); pos += 8; }
      else if (!(full.flags & 0x020000) && trafs.length !== 1) {
        fail("Implicit multi-track data offsets unsupported");
      }
      if (full.flags & 2) { description = r.u32(pos, tfhd.end); pos += 4; }
      if (full.flags & 8) { defaultDuration = r.u32(pos, tfhd.end); pos += 4; }
      if (full.flags & 16) { defaultSize = r.u32(pos, tfhd.end); pos += 4; }
      if (full.flags & 32) { r.need(pos, 4, tfhd.end); pos += 4; }
      if (full.flags & 0x010000) continue; // duration-is-empty
      if (description !== 1) fail("Unsupported subtitle sample description index");
      if (pos !== tfhd.end) fail("Unexpected tfhd data");
      const tfdt = r.one(parts, "tfdt");
      const time = r.full(tfdt, [0, 1]);
      let decodeTime = time.version ? r.u64(time.pos, tfdt.end) : r.u32(time.pos, tfdt.end);
      const runs = parts.filter((b) => b.type === "trun");
      if (!runs.length) fail("Missing subtitle trun");
      let nextData = null;
      for (const trun of runs) {
        const run = r.full(trun, [0, 1]);
        const count = r.u32(run.pos, trun.end);
        budget.samples += count;
        if (budget.samples > LIMITS.samples) fail("Too many subtitle samples");
        pos = run.pos + 4;
        if (run.flags & 1) { nextData = base + r.i32(pos, trun.end); pos += 4; }
        if (run.flags & 4) { r.need(pos, 4, trun.end); pos += 4; }
        if (nextData === null && count) fail("Missing subtitle sample data offset");
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration;
          let size = defaultSize;
          let compositionOffset = 0;
          if (run.flags & 0x100) { duration = r.u32(pos, trun.end); pos += 4; }
          if (run.flags & 0x200) { size = r.u32(pos, trun.end); pos += 4; }
          if (run.flags & 0x400) { r.need(pos, 4, trun.end); pos += 4; }
          if (run.flags & 0x800) {
            compositionOffset = run.version ? r.i32(pos, trun.end) : r.u32(pos, trun.end);
            pos += 4;
          }
          if (!size || size > LIMITS.sampleBytes) fail("Missing/oversize subtitle sample");
          if (!duration) fail("Missing subtitle sample duration");
          if (!Number.isSafeInteger(nextData) || !mdats.some((mdat) => nextData >= mdat.data && nextData + size <= mdat.end)) {
            fail("Subtitle sample lies outside mdat");
          }
          const begin = decodeTime + compositionOffset;
          const finish = begin + duration;
          decodeTime += duration;
          if (![begin, finish, decodeTime].every(Number.isSafeInteger)) fail("Unsafe subtitle timestamp");
          const start = begin / track.timescale;
          const end = finish / track.timescale;
          if (track.codec === "wvtt") {
            for (const cueBox of r.boxes(nextData, nextData + size)) {
              if (cueBox.type === "vtte") continue;
              if (cueBox.type !== "vttc") continue;
              const payload = r.one(r.children(cueBox), "payl", false);
              if (!payload) continue;
              const text = plainVtt(UTF8.decode(r.bytes.subarray(payload.data, payload.end)));
              if (text) {
                if (result.cues.length >= LIMITS.samples) fail("Too many subtitle cues");
                result.cues.push({ start, end, text, trackId: trackID, language: track.language });
              }
            }
          } else {
            const xml = UTF8.decode(r.bytes.subarray(nextData, nextData + size)).replace(/^\uFEFF/, "").trim();
            // Plain-text TTML only: no entity declarations, compressed bodies,
            // image subsamples, external entities, or arbitrary XML documents.
            if (!/^(?:<\?xml[^>]*>\s*)?<(?:[\w.-]+:)?tt(?:\s|>)/i.test(xml) ||
                /<!DOCTYPE|<!ENTITY|\u0000/i.test(xml)) fail("Unsupported STPP payload");
            result.ttml.push({ xml, start, end, trackId: trackID, language: track.language });
          }
          nextData += size;
        }
        if (pos !== trun.end) fail("Unexpected trun data");
      }
    }
  }

  function createParser() {
    let tracks = new Map();
    return {
      reset() { tracks = new Map(); },
      parse(input) {
        const result = { cues: [], ttml: [], tracks: [], warnings: [], rejected: false };
        try {
          const bytes = asBytes(input);
          if (!bytes.length || bytes.length > LIMITS.segmentBytes) fail("Empty/oversize MP4 segment");
          const r = reader(bytes);
          const top = r.boxes(0, bytes.length);
          let nextTracks = tracks;
          const moovs = top.filter((b) => b.type === "moov");
          if (moovs.length > 1) fail("Multiple init segments in one buffer");
          if (moovs.length) nextTracks = readInit(r, moovs[0], result.warnings);
          const mdats = top.filter((b) => b.type === "mdat");
          const budget = { samples: 0 };
          for (const moof of top.filter((b) => b.type === "moof")) {
            readFragment(r, moof, mdats, nextTracks, result, budget);
          }
          tracks = nextTracks; // Commit init metadata only after validation.
          result.tracks = [...tracks.values()].filter((t) => t.codec && !t.encrypted)
            .map(({ id, timescale, codec, language }) => ({ id, timescale, codec, language }));
        } catch (error) {
          result.cues = [];
          result.ttml = [];
          result.rejected = true;
          result.warnings.push(error instanceof Error ? error.message : "Invalid MP4 data");
        }
        return result;
      },
    };
  }

  const api = Object.freeze({ createParser, LIMITS });
  root.LLMSubtitleParser = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
