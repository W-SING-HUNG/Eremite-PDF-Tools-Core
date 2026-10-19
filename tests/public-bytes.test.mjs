import assert from "node:assert/strict";
import { gzipSync, deflateSync, crc32 } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanPublicBytes, scanPublicText, checkPublicExposure } from "../scripts/check-public-exposure.mjs";

const token = "ghp_" + "Ab12Cd34".repeat(5);
const scan = (name, bytes) => scanPublicBytes(name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
const rejects = (name, bytes, rule) => assert.ok(scan(name, bytes).some(f => f.rule === rule), rule + " at " + name);
function tar(name, bytes, type = "0") {
  const h = Buffer.alloc(512); h.write(name); h.write("0000644\0", 100);
  h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136); h.fill(32, 148, 156); h.write(type, 156); h.write("ustar\0", 257);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]);
}
function zip(name, bytes, flags = 0) {
  const n = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6);
  local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(n.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(flags, 8);
  central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(n.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + bytes.length, 16);
  return Buffer.concat([local, n, bytes, central, n, end]);
}
rejects("payload.txt", token, "credential");
rejects("node_modules/private.txt", "Synthetic file", "private-or-generated-file");
rejects("renamed.bin", Buffer.from("377abcaf271c0000", "hex"), "unsupported-or-invalid-archive");
const compressed = deflateSync(Buffer.from(token));
rejects("document.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> stream\n"), compressed, Buffer.from("\nendstream\nendobj")]), "credential");
rejects("payload.bin", Buffer.from(token, "utf16le"), "credential");
const be = Buffer.from(token, "utf16le"); be.swap16(); rejects("payload.bin", be, "credential");
for (const value of [Buffer.from(token).toString("base64"), [...token].map(c => "%"+c.charCodeAt(0).toString(16)).join(""),
  [...token].map(c => "\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")).join(""),
  [...token].map(c => "&#"+c.charCodeAt(0)+";").join("")]) {
  assert.ok(scanPublicText("metadata", value).some(f => f.rule === "credential"));
}
rejects("package.tgz", gzipSync(tar("package/hidden.txt", Buffer.from(token))), "credential");
rejects("package.tgz", gzipSync(tar("package/.env", Buffer.from("private=synthetic"))), "private-or-generated-file");
rejects("bundle.zip", zip("nested.tgz", gzipSync(tar("package/hidden", Buffer.from(token)))), "credential");
rejects("document.docx", zip("docProps/core.xml", Buffer.from(token)), "credential");
rejects("bundle.zip", zip("../escape", Buffer.from("synthetic")), "uninspectable-archive");
rejects("bundle.zip", zip("safe", Buffer.from("synthetic"), 1), "uninspectable-archive");
rejects("bundle.zip", zip("safe", Buffer.from(token)).subarray(0, 50), "uninspectable-archive");
const paxBody = "path=package/.env\n";
let paxLength = Buffer.byteLength(paxBody) + 2;
while (Buffer.byteLength(paxLength + " " + paxBody) !== paxLength) paxLength = Buffer.byteLength(paxLength + " " + paxBody);
const pax = tar("PaxHeader", Buffer.from(paxLength + " " + paxBody), "x").subarray(0, -1024);
rejects("pax.tar", Buffer.concat([pax, tar("package/innocent", Buffer.from("synthetic"))]), "private-or-generated-file");
const gz = gzipSync(Buffer.from("Public content")); gz[3] |= 8;
rejects("metadata.gz", Buffer.concat([gz.subarray(0, 10), Buffer.from(token + "\0"), gz.subarray(10)]), "credential");
const malformedZip = zip("safe", Buffer.from("synthetic")); malformedZip[34] ^= 1;
rejects("checksum.zip", malformedZip, "uninspectable-archive");
rejects("bundle.tgz", Buffer.from("not an archive"), "unsupported-or-invalid-archive");
rejects("bundle.tgz", gzipSync(tar("package/link", Buffer.from("synthetic"), "2")), "unsupported-archive-entry");
const broken = tar("package/safe", Buffer.from("synthetic")); broken[0] ^= 1;
rejects("broken.tar", broken, "uninspectable-archive");
const author = ["author", "upstream.org"].join("@");
assert.deepEqual(scan("package.tgz", gzipSync(tar("package/node_modules/upstream/package.json", Buffer.from(JSON.stringify({author}))))), []);
assert.deepEqual(scan("package.tgz", gzipSync(tar("package/NOTICE", Buffer.from("Copyright Example Author <"+author+">")))), []);
rejects("package.tgz", gzipSync(tar("package/NOTICE", Buffer.from(token))), "credential");
assert.ok(!JSON.stringify(scan("bundle.zip", zip("payload", Buffer.from(token)))).includes(token));

const root = mkdtempSync(path.join(tmpdir(), "public-bytes-"));
const cli = fileURLToPath(new URL("../scripts/check-public-exposure.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
for (const key of ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
const git = (...args) => { const r = spawnSync("git",args,{cwd:root,env,windowsHide:true,encoding:"utf8"}); assert.equal(r.status,0,r.stderr); };
try {
  git("init","-b","main");
  writeFileSync(path.join(root,"new.txt"),token);
  assert.ok(checkPublicExposure({cwd:root,includeUntracked:true}).findings.some(f=>f.rule==="credential"));
  writeFileSync(path.join(root,"new.txt"),"Public documentation");
  const privacy = { GIT_AUTHOR_NAME:"Fixture Author", GIT_COMMITTER_NAME:"Fixture Author",
    GIT_AUTHOR_EMAIL:"fixture@users.noreply.github.com", GIT_COMMITTER_EMAIL:"fixture@users.noreply.github.com" };
  const run = (args, extra = {}) => spawnSync(process.execPath,[cli,...args],{cwd:root,env:{...env,...privacy,...extra},windowsHide:true,encoding:"utf8"});
  assert.equal(run(["--check-identity"]).status,0);
  const denied=run(["--check-identity"],{GIT_AUTHOR_EMAIL:author});
  assert.equal(denied.status,1); assert.doesNotMatch(denied.stderr,/upstream\.org/u);
  // Exercise the installed Git hooks against a disposable repository, not just direct scanner calls.
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const name of ["check-public-exposure.mjs", "public-bytes.mjs"])
    copyFileSync(fileURLToPath(new URL("../scripts/" + name, import.meta.url)), path.join(root, "scripts", name));
  git("config", "core.hooksPath", fileURLToPath(new URL("../.githooks", import.meta.url)));
  const commit = (message, extra = {}) => spawnSync("git", ["commit", "--no-gpg-sign", "-m", message], {
    cwd: root, env: { ...env, ...privacy, ...extra }, windowsHide: true, encoding: "utf8",
  });
  writeFileSync(path.join(root, "new.txt"), token); git("add", "--", "new.txt");
  assert.notEqual(commit("Synthetic hook rejection").status, 0);
  writeFileSync(path.join(root, "new.txt"), "Public content"); git("add", "--", "new.txt");
  assert.notEqual(commit("Synthetic identity rejection", { GIT_AUTHOR_EMAIL: author }).status, 0);
  const badMessage = commit(token); assert.notEqual(badMessage.status, 0); assert.ok(!badMessage.stderr.includes(token));
  assert.equal(commit("Synthetic public hook acceptance").status, 0);
  const event = path.join(root,"event.json");
  writeFileSync(event,JSON.stringify({release:{name:"Release",body:Buffer.from(token).toString("base64")}}));
  assert.equal(run([], {GITHUB_ACTIONS:"true",GITHUB_EVENT_NAME:"release",GITHUB_EVENT_PATH:event}).status,1);
  writeFileSync(event,JSON.stringify({release:{name:"Release",body:"Supported behavior and attribution."}}));
  assert.equal(run([], {GITHUB_ACTIONS:"true",GITHUB_EVENT_NAME:"release",GITHUB_EVENT_PATH:event}).status,0);
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));
  assert.ok(path.basename(root).startsWith("public-bytes-")); rmSync(root,{recursive:true,force:true});
}
console.log("Public byte regression passed: encodings, nested archives, metadata, untracked files, proposed identities and release events.");
