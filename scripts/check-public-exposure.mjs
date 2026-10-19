import { readFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectPublicBytes } from "./public-bytes.mjs";
import path from "node:path";

// These names are policy examples, not claims about how this project was developed.
// Only this rule definition and its synthetic test may contain those examples.
const policyFiles = new Set(["scripts/check-public-exposure.mjs", "tests/public-exposure.test.mjs", "scripts/public-bytes.mjs", "tests/public-bytes.test.mjs"]);
const rules = [
  ["credential", /\b(?:xox[baprs]-[A-Za-z0-9-]{24,}|npm_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})|https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/gu],
  ["credential", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{25,}|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}/gu],
  ["private-path", /\b[A-Za-z]:[\\/](?:Users[\\/](?!Public(?:[\\/]|\b))[^\s"'<>]+|Codex_program[^\s"'<>]*|豆包[^\s"'<>]*)|\/(?:Users|home)\/(?!runner(?:[\/]|\b))[^\s"'<>]+/gu],
  ["internal-reference", /\bEremite-internal\b|\bPROJECT-STATE\.md\b|docs[\\/](?:evidence|internal)[\\/]|\.codex[\\/](?:sessions|memories|worktrees)|\.agents[\\/]skills/giu],
  ["development-tool", /\b(?:Qoder|Codex|WorkBuddy|ChatGPT|Claude Code|Claude Desktop|Cursor IDE|Cursor AI)\b/giu],
  ["personal-email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
];

function publicEmail(value) {
  const lower = value.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return /(?:^|\.)(?:example\.(?:com|net|org)|invalid|test)$/u.test(domain)
    || domain === "users.noreply.github.com" || lower === "noreply@github.com";
}

function commitPrivacyEmail(value) {
  return /^[^@\s<>]+@users\.noreply\.github\.com$/iu.test(value) || value.toLowerCase() === "noreply@github.com";
}

function scanPlainPublicText(location, text, { thirdPartyAttribution = false } = {}) {
  const findings = [];
  const policyDefinition = policyFiles.has(location);
  const legalText = /(?:^|\/)(?:LICENSE(?:\.[^/]+)?|NOTICE|THIRD-PARTY-NOTICES(?:\.md)?|AUTHORS(?:\.[^/]+)?|COPYING(?:\.[^/]+)?)$/iu.test(location);
  for (const [rule, regex] of rules) {
    if (policyDefinition && ["development-tool", "internal-reference"].includes(rule)) continue;
    if (rule === "development-tool" && (legalText || thirdPartyAttribution)) continue;
    if (rule === "personal-email" && (legalText || thirdPartyAttribution)) continue;
    const scanned = ["private-path", "internal-reference"].includes(rule) ? text.replace(/\\{2,}/gu, "\\") : text;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(scanned))) {
      if (rule === "personal-email" && publicEmail(match[0])) continue;
      if (rule === "development-tool") {
        if (location === "scripts/consumer-smoke.mjs" && match[0].toLowerCase() === "workbuddy" && scanned[match.index - 1] === ".") continue;
        const start = scanned.lastIndexOf("\n", match.index - 1) + 1;
        const end = scanned.indexOf("\n", match.index);
        const line = scanned.slice(start, end < 0 ? undefined : end);
        const column = match.index - start;
        const packageMetadata = /(?:^|\/)package(?:-lock)?\.json$/u.test(location);
        const key = /^\s*"((?:node_modules\/)?(?:@[^"/]+\/)?[a-z0-9._-]+)"\s*:/u.exec(line);
        if (packageMetadata && key && column < key[0].lastIndexOf(":")) continue;
        if (packageMetadata && /^\s*"(?:name|resolved)"\s*:\s*"/u.test(line)) continue;
        // A typed model identifier names a supported product input, not a validation assistant.
        if (/\bmodel(?:Id)?["']?\s*:\s*["'][a-z0-9._/-]+["']\s*[,;}]?\s*$/iu.test(line)) continue;
      }
      findings.push({ location, line: scanned.slice(0, match.index).split("\n").length, rule });
    }
  }
  return findings;
}

export function scanPublicText(location, text, options = {}) {
  const candidates = new Set([text.normalize("NFKC")]);
  for (let pass = 0; pass < 2; pass++) for (const value of [...candidates]) {
    const decoded = value.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|&#(x[0-9a-f]+|\d+);|&(?:commat|colon|sol|bsol);/giu, (all, u, x, entity) => {
      if (u || x) return String.fromCharCode(Number.parseInt(u || x, 16));
      if (entity) { const code = entity[0].toLowerCase() === "x" ? Number.parseInt(entity.slice(1), 16) : Number(entity); return code <= 0x10ffff ? String.fromCodePoint(code) : all; }
      return ({ "&commat;": "@", "&colon;": ":", "&sol;": "/", "&bsol;": "\\" })[all.toLowerCase()] ?? all;
    }).replace(/(?:%[0-9a-f]{2})+/giu, encoded => { try { return decodeURIComponent(encoded); } catch { return encoded; } });
    if (decoded !== value) candidates.add(decoded);
    for (const match of value.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,}={0,2}(?![A-Za-z0-9+/_=-])/gu)) {
      if (match[0].length > 65536) continue;
      const decodedBytes = Buffer.from(match[0], "base64");
      const candidate = decodedBytes.toString("utf8");
      if (candidate.length >= 8 && [...candidate].filter(c => /[\x20-\x7e\r\n\t]/u.test(c)).length / candidate.length > 0.9) candidates.add(candidate);
    }
    if (candidates.size > 1000) return [{ location, line: 1, rule: "inspection-limit" }];
  }
  const unique = new Map();
  for (const candidate of candidates) for (const finding of scanPlainPublicText(location, candidate, options)) unique.set(JSON.stringify(finding), finding);
  return [...unique.values()];
}

export function scanPublicBytes(location, bytes) {
  return inspectPublicBytes(location, bytes, scanPublicText);
}


export function checkPublicExposure({ cwd = process.cwd(), staged = false, textFiles = [], extraFiles = [], includeUntracked = false, checkIdentity = false, base, head = "HEAD" } = {}) {
  const findings = [];
  function git(...args) {
    const result = spawnSync("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("Cannot inspect public Git snapshot");
    return result.stdout;
  }
  const filenames = git("ls-files", "--cached", ...(includeUntracked && !staged ? ["--others", "--exclude-standard"] : []), "-z").toString("utf8").split("\0").filter(Boolean);
  for (const filename of new Set([...filenames, ...extraFiles])) {
    if (!staged && lstatSync(path.isAbsolute(filename) ? filename : path.join(cwd, filename)).isSymbolicLink()) { findings.push({ location: "source entry", line: 1, rule: "symbolic-file" }); continue; }
    const bytes = staged && filenames.includes(filename) ? git("show", ":" + filename) : readFileSync(path.isAbsolute(filename) ? filename : path.join(cwd, filename));
    findings.push(...scanPublicBytes(filenames.includes(filename) ? filename : "prepared file " + path.basename(filename), bytes));
  }
  for (const file of textFiles) findings.push(...scanPublicBytes("submitted metadata", readFileSync(file)));
  if (checkIdentity) {
    for (const role of ["AUTHOR", "COMMITTER"]) {
      const identity = git("var", "GIT_" + role + "_IDENT").toString("utf8");
      findings.push(...scanPublicText("proposed " + role.toLowerCase() + " identity", identity));
      const email = /<([^>]+)>/u.exec(identity)?.[1];
      if (!email || !commitPrivacyEmail(email)) findings.push({ location: "proposed identity", line: 1, rule: "commit-identity", role: role.toLowerCase() });
    }
  }
  if (base) {
    // Only new commits are checked; historical objects are never silently rewritten.
    const commits = git("rev-list", /^0+$/u.test(base) ? head : `${base}..${head}`).toString("utf8").trim().split("\n").filter(Boolean);
    for (const sha of commits) {
      const message = git("show", "-s", "--format=%B", sha).toString("utf8");
      const changed = git("diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "--diff-filter=AM", "-z", sha).toString("utf8").split("\0").filter(Boolean);
      for (const filename of changed) findings.push(...scanPublicBytes(filename, git("show", sha + ":" + filename)));
      findings.push(...scanPublicText("new commit " + sha.slice(0, 12), message));
      const identity = git("show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", sha).toString("utf8").trimEnd().split("\0");
      const location = "new commit identity " + sha.slice(0, 12);
      findings.push(...scanPublicText(location, `${identity[0]} <${identity[1]}>\n${identity[2]} <${identity[3]}>`));
      for (const [role, email] of [["author", identity[1]], ["committer", identity[3]]]) {
        if (!email || !commitPrivacyEmail(email)) findings.push({ location, line: 1, rule: "commit-identity", role });
      }
    }
  }
  return { files: filenames.length + extraFiles.length, findings };
}

function main(args) {
  const options = { textFiles: [], extraFiles: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--staged") options.staged = true;
    else if (arg === "--include-untracked") options.includeUntracked = true;
    else if (arg === "--check-identity") options.checkIdentity = true;
    else if (["--base", "--head", "--text-file", "--extra-file"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing check option value");
      if (arg === "--text-file") options.textFiles.push(value);
      else if (arg === "--extra-file") options.extraFiles.push(value);
      else options[arg.slice(2)] = value;
    } else throw new Error("Unknown public exposure check option");
  }
  if (!options.base && process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      options.base = event.pull_request.base.sha;
      options.head = event.pull_request.head.sha;
      options.textFiles = [...options.textFiles];
      const metadata = event.pull_request.title + "\n" + (event.pull_request.body ?? "");
      const findings = scanPublicText("pull request metadata", metadata);
      if (findings.length) { console.error(JSON.stringify({ findings })); process.exitCode = 1; return; }
    } else if (process.env.GITHUB_EVENT_NAME === "push") options.base = event.before;
    else if (process.env.GITHUB_EVENT_NAME === "release") {
      const findings = scanPublicText("release metadata", (event.release.name ?? "") + "\n" + (event.release.body ?? ""));
      if (findings.length) { console.error(JSON.stringify({ findings })); process.exitCode = 1; return; }
    }
  }
  const result = checkPublicExposure(options);
  if (result.findings.length) { console.error(JSON.stringify(result)); process.exitCode = 1; }
  else console.log(`Public exposure check passed: ${result.files} tracked files, fixed archives and submitted metadata; matched values are never printed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Public exposure check failed: snapshot or metadata could not be inspected."); process.exitCode = 1; }
}
