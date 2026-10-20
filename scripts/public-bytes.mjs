import { gunzipSync, inflateRawSync, inflateSync, crc32 } from "node:zlib";
import path from "node:path";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const field = b => b.toString("utf8").replace(/\0.*$/su, "");
const looksLikeTar = bytes => {
  if (bytes.length < 512) return false;
  const h = bytes.subarray(0, 512), value = field(h.subarray(148, 156)).trim();
  return /^[0-7]+$/u.test(value) && Number.parseInt(value, 8)
    === h.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
};
const safeName = name => name && !name.includes("\0") && !name.includes("\\")
  && !path.posix.isAbsolute(name) && !/^[a-z]:/iu.test(name) && !name.split("/").includes("..");
const privateName = name => /(?:^|[!/])(?:\.git|\.qa|\.codex|\.agents|\.workbuddy|data|coverage|\.next(?:-dev)?)(?:\/|$)/iu.test(name)
  || /(?:^|[!/])docs\/(?:internal|evidence)\//iu.test(name)
  || /(?:^|[!/])\.env(?:\.(?!example$)[^/]*)?$/iu.test(name)
  || /\.(?:sqlite(?:-wal|-shm)?|db|log|tsbuildinfo)$/iu.test(name)
  || /(?:^|[!/])PROJECT-STATE\.md$/u.test(name);

export function inspectPublicBytes(location, bytes, scanText, findings = [], state = { bytes: 0, entries: 0 }, depth = 0) {
  const add = rule => findings.push({ location, line: 1, rule });
  if (depth > 5 || bytes.length > MAX_BYTES || (state.bytes += bytes.length) > MAX_TOTAL || ++state.entries > MAX_ENTRIES) {
    add("inspection-limit"); return findings;
  }
  if (privateName(location)) add("private-or-generated-file");
  if (!location.includes("!") && location.startsWith("node_modules/")) add("private-or-generated-file");
  if (/^(?:377abcaf271c|526172211a07|425a68|fd377a585a00|28b52ffd)/u.test(bytes.subarray(0, 8).toString("hex"))) add("unsupported-or-invalid-archive");
  if (bytes.subarray(0, 16).toString("ascii") === "SQLite format 3\0") add("database-payload");
  // Dependency authorship and license text remain intact; paths and credentials never receive this exemption.
  const thirdPartyAttribution = /!.*(?:^|\/)node_modules\/.*\/(?:package\.json|licen[sc]e(?:\.[^/]*)?|notice(?:\.[^/]*)?)$/iu.test(location);
  const scan = text => findings.push(...scanText(location, text, { thirdPartyAttribution }));
  const tarContainer = looksLikeTar(bytes) || /\.tar$/iu.test(location);
  const container = bytes[0] === 0x1f && bytes[1] === 0x8b || bytes.subarray(0, 2).toString() === "PK" || tarContainer || /\.(?:tgz|zip|gz)$/iu.test(location);
  scan(location);
  if (!container) scan(bytes.toString("utf8"));
  if (!container && bytes.includes(0)) {
    scan(bytes.toString("utf16le"));
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - bytes.length % 2));
    swapped.swap16(); scan(swapped.toString("utf16le"));
  }
  if (bytes.subarray(0, 4).toString() === "%PDF") {
    const text = bytes.toString("latin1");
    for (const m of text.matchAll(/<((?:feff|fffe)[0-9a-f]{8,})>/giu)) {
      const raw = Buffer.from(m[1], "hex");
      if (raw[0] === 0xfe) raw.swap16();
      scan(raw.toString("utf16le"));
    }
    for (const m of text.matchAll(/<<[^<>]*\/FlateDecode[^<>]*>>\s*stream\r?\n/gu)) {
      const start = m.index + m[0].length, end = text.indexOf("endstream", start);
      try {
        if (end < 0) throw Error();
        const decoded = inflateSync(bytes.subarray(start, end), { maxOutputLength: MAX_BYTES });
        inspectPublicBytes(location + "!document-stream", decoded, scanText, findings, state, depth + 1);
      } catch { add("uninspectable-document-stream"); }
    }
  }
  const child = (name, data) => inspectPublicBytes(location + "!" + name, data, scanText, findings, state, depth + 1);
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (bytes.length < 18 || bytes[3] & 0xe0) throw Error();
      let headerEnd = 10;
      if (bytes[3] & 4) { if (headerEnd + 2 > bytes.length) throw Error(); headerEnd += 2 + bytes.readUInt16LE(headerEnd); }
      for (const flag of [8, 16]) if (bytes[3] & flag) {
        const end = bytes.indexOf(0, headerEnd); if (end < headerEnd || end > bytes.length - 8) throw Error(); headerEnd = end + 1;
      }
      if (bytes[3] & 2) headerEnd += 2;
      if (headerEnd > bytes.length - 8) throw Error();
      scan(bytes.subarray(0, headerEnd).toString("utf8"));
      child(/\.(?:tgz|tar\.gz)$/iu.test(location) ? "gzip-content.tar" : "gzip-content", gunzipSync(bytes, { maxOutputLength: MAX_BYTES }));
    } else if (/PK[\x03\x05\x07][\x04\x06\x08]/u.test(bytes.subarray(0, 4).toString("latin1")) || /\.(?:zip|docx|xlsx|pptx|odt|ods|epub)$/iu.test(location)) {
      let eocd = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0 || eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw Error();
      const count = bytes.readUInt16LE(eocd + 10), directorySize = bytes.readUInt32LE(eocd + 12);
      let offset = bytes.readUInt32LE(eocd + 16), directoryStart = offset;
      if (count === 0xffff || offset + directorySize !== eocd || count > MAX_ENTRIES) throw Error();
      scan(bytes.subarray(eocd + 22).toString("utf8"));
      for (let n = 0; n < count; n++) {
        if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw Error();
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
        const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
        const nl = bytes.readUInt16LE(offset + 28), el = bytes.readUInt16LE(offset + 30), cl = bytes.readUInt16LE(offset + 32);
        const local = bytes.readUInt32LE(offset + 42);
        const name = bytes.subarray(offset + 46, offset + 46 + nl).toString("utf8");
        if (!safeName(name) || offset + 46 + nl + el + cl > eocd || flags & 1 || size > MAX_BYTES || ![0, 8].includes(method)) throw Error();
        scan(bytes.subarray(offset + 46, offset + 46 + nl + el + cl).toString("utf8"));
        if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) throw Error();
        const localNameSize = bytes.readUInt16LE(local + 26);
        if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.subarray(local + 30, local + 30 + localNameSize).toString("utf8") !== name) throw Error();
        const start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
        if (start + compressed > directoryStart) throw Error();
        const payload = bytes.subarray(start, start + compressed);
        const data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: MAX_BYTES });
        if (data.length !== size || crc32(data) !== bytes.readUInt32LE(offset + 16)) throw Error();
        if (!name.endsWith("/")) child(name, data);
        offset += 46 + nl + el + cl;
      }
      if (offset !== directoryStart + directorySize) throw Error();
    } else if (tarContainer) {
      let offset = 0, nextName, globalPax = {};
      while (offset + 512 <= bytes.length && !bytes.subarray(offset, offset + 512).every(b => b === 0)) {
        const h = bytes.subarray(offset, offset + 512);
        const stored = Number.parseInt(field(h.subarray(148, 156)).trim(), 8);
        const sum = h.reduce((total, b, i) => total + (i >= 148 && i < 156 ? 32 : b), 0);
        const rawSize = field(h.subarray(124, 136)).trim();
        const size = /^[0-7]+$/u.test(rawSize) ? Number.parseInt(rawSize, 8) : NaN;
        if (stored !== sum || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw Error();
        const prefix = field(h.subarray(345, 500));
        const rawName = (prefix ? prefix + "/" : "") + field(h.subarray(0, 100));
        const data = bytes.subarray(offset + 512, offset + 512 + size), type = h[156];
        scan(h.toString("utf8"));
        if ([120, 103].includes(type)) {
          scan(data.toString("utf8"));
          const values = {}; let at = 0;
          while (at < data.length) {
            const space = data.indexOf(32, at), length = Number(data.subarray(at, space).toString());
            if (space < at || !Number.isSafeInteger(length) || length <= space - at + 1 || at + length > data.length) throw Error();
            const entry = data.subarray(space + 1, at + length - 1).toString("utf8"), eq = entry.indexOf("=");
            if (eq < 0) throw Error(); values[entry.slice(0, eq)] = entry.slice(eq + 1); at += length;
          }
          if (Object.keys(values).some(k => /sparse|size/iu.test(k))) throw Error();
          if (type === 103) globalPax = { ...globalPax, ...values };
          else nextName = values.path;
        } else if (type === 76) { scan(data.toString("utf8")); nextName = field(data); }
        else {
          const name = nextName || globalPax.path || rawName; nextName = undefined;
          if (!safeName(name)) throw Error();
          if ([0, 48].includes(type)) child(name, data);
          else if (type !== 53) { add("unsupported-archive-entry"); }
        }
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      if (nextName || offset + 1024 > bytes.length || !bytes.subarray(offset).every(b => b === 0)) throw Error();
    } else if (/\.(?:tgz|gz|7z|rar|bz2|xz|zst)$/iu.test(location)) add("unsupported-or-invalid-archive");
  } catch { add("uninspectable-archive"); }
  return findings;
}
