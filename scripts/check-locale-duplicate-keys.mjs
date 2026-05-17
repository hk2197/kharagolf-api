#!/usr/bin/env node
/**
 * Repository guard against duplicate keys in locale JSON bundles
 * (Task #2265).
 *
 * `JSON.parse` silently keeps only the LAST value for a duplicated key,
 * so a copy-pasted block in a locale file can wipe out previously
 * translated strings without anyone noticing — admins then see the
 * English fallback instead of the localized copy. This regressed the
 * snooze translations recently: every one of the 20 non-English
 * `admin.json` files defined `"certStatus": { … }` twice, and the
 * second (small) block silently overwrote the first (full) one.
 *
 * This script walks every `*.json` file under
 *
 *   artifacts/kharagolf-web/src/i18n/locales/
 *
 * and parses each file with a duplicate-key-aware tokenizer. If any
 * object literal — top-level or nested — declares the same key twice,
 * the script prints the offending file, the JSON pointer to the parent
 * object, the duplicated key, and both line/column positions, then
 * exits non-zero.
 *
 * Flags:
 *   --self-test   exercise the detection logic with fixture cases
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const LOCALES_DIR = join(
  REPO_ROOT,
  "artifacts/kharagolf-web/src/i18n/locales",
);

/**
 * Duplicate-key-aware JSON parser. Returns the list of duplicate
 * occurrences found while parsing `text`. Throws SyntaxError on
 * malformed JSON so callers learn about that as well.
 *
 * Each duplicate entry has:
 *   { key, pointer, firstLine, firstCol, dupLine, dupCol }
 *
 * The implementation is a small recursive-descent parser specialised
 * for the JSON grammar (RFC 8259). It is intentionally self-contained
 * so the lint script has zero runtime dependencies.
 */
function findDuplicateKeys(text) {
  const duplicates = [];
  let i = 0;
  let line = 1;
  let col = 1;

  function posOf(idx) {
    let ln = 1;
    let cl = 1;
    for (let k = 0; k < idx; k++) {
      if (text.charCodeAt(k) === 10) {
        ln += 1;
        cl = 1;
      } else {
        cl += 1;
      }
    }
    return { line: ln, col: cl };
  }

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (text.charCodeAt(i) === 10) {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  }

  function skipWhitespace() {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        advance();
      } else {
        break;
      }
    }
  }

  function fail(msg) {
    throw new SyntaxError(`${msg} at line ${line}, col ${col}`);
  }

  function parseString() {
    if (text[i] !== '"') fail("Expected string");
    advance();
    let out = "";
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        advance();
        return out;
      }
      if (ch === "\\") {
        advance();
        const esc = text[i];
        advance();
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Bad \\u escape");
            advance(4);
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            fail(`Bad escape \\${esc}`);
        }
      } else {
        out += ch;
        advance();
      }
    }
    fail("Unterminated string");
    return "";
  }

  function parseValue(pointer) {
    skipWhitespace();
    const ch = text[i];
    if (ch === "{") return parseObject(pointer);
    if (ch === "[") return parseArray(pointer);
    if (ch === '"') {
      parseString();
      return;
    }
    if (ch === "t" || ch === "f" || ch === "n") {
      const literal =
        ch === "t" ? "true" : ch === "f" ? "false" : "null";
      if (text.slice(i, i + literal.length) !== literal)
        fail(`Expected ${literal}`);
      advance(literal.length);
      return;
    }
    // number
    const start = i;
    if (text[i] === "-") advance();
    while (i < text.length && /[0-9.eE+\-]/.test(text[i])) advance();
    if (i === start) fail("Expected value");
  }

  function parseObject(pointer) {
    if (text[i] !== "{") fail("Expected '{'");
    advance();
    const seen = new Map();
    skipWhitespace();
    if (text[i] === "}") {
      advance();
      return;
    }
    while (true) {
      skipWhitespace();
      const keyStartIdx = i;
      const key = parseString();
      skipWhitespace();
      if (text[i] !== ":") fail("Expected ':'");
      advance();
      const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      parseValue(childPointer);
      if (seen.has(key)) {
        const first = seen.get(key);
        const dup = posOf(keyStartIdx);
        duplicates.push({
          key,
          pointer: pointer === "" ? "(root)" : pointer,
          firstLine: first.line,
          firstCol: first.col,
          dupLine: dup.line,
          dupCol: dup.col,
        });
      } else {
        seen.set(key, posOf(keyStartIdx));
      }
      skipWhitespace();
      if (text[i] === ",") {
        advance();
        continue;
      }
      if (text[i] === "}") {
        advance();
        return;
      }
      fail("Expected ',' or '}'");
    }
  }

  function parseArray(pointer) {
    if (text[i] !== "[") fail("Expected '['");
    advance();
    skipWhitespace();
    if (text[i] === "]") {
      advance();
      return;
    }
    let idx = 0;
    while (true) {
      parseValue(`${pointer}/${idx}`);
      idx += 1;
      skipWhitespace();
      if (text[i] === ",") {
        advance();
        continue;
      }
      if (text[i] === "]") {
        advance();
        return;
      }
      fail("Expected ',' or ']'");
    }
  }

  parseValue("");
  skipWhitespace();
  if (i < text.length) fail("Trailing content");
  return duplicates;
}

function* walkJsonFiles(root) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkJsonFiles(full);
    } else if (entry.endsWith(".json")) {
      yield full;
    }
  }
}

function runLint() {
  let files = 0;
  let problems = 0;
  for (const file of walkJsonFiles(LOCALES_DIR)) {
    files += 1;
    const text = readFileSync(file, "utf8");
    let dups;
    try {
      dups = findDuplicateKeys(text);
    } catch (err) {
      console.error(
        `[locale-duplicate-keys] ${relative(REPO_ROOT, file)}: parse error: ${err.message}`,
      );
      problems += 1;
      continue;
    }
    for (const d of dups) {
      problems += 1;
      console.error(
        `[locale-duplicate-keys] ${relative(REPO_ROOT, file)}: duplicate key "${d.key}" in ${d.pointer} ` +
          `(first defined at line ${d.firstLine}:${d.firstCol}, repeated at line ${d.dupLine}:${d.dupCol})`,
      );
    }
  }
  if (problems > 0) {
    console.error(
      `\n[locale-duplicate-keys] FAIL — ${problems} duplicate-key issue(s) across ${files} file(s).`,
    );
    console.error(
      "Merge the duplicated blocks into a single object literal so JSON.parse does not silently drop earlier values.",
    );
    process.exit(1);
  }
  console.log(
    `[locale-duplicate-keys] OK — ${files} locale JSON file(s) scanned, no duplicate keys.`,
  );
}

function runSelfTest() {
  const cases = [
    {
      name: "clean object passes",
      json: '{"a":1,"b":{"c":2,"d":3}}',
      expect: [],
    },
    {
      name: "top-level duplicate detected",
      json: '{"a":1,"a":2}',
      expect: [{ key: "a", pointer: "(root)" }],
    },
    {
      name: "nested duplicate detected",
      json: '{"outer":{"x":1,"x":2}}',
      expect: [{ key: "x", pointer: "/outer" }],
    },
    {
      name: "duplicate inside array element",
      json: '{"arr":[{"k":1,"k":2}]}',
      expect: [{ key: "k", pointer: "/arr/0" }],
    },
    {
      name: "same key in sibling objects is fine",
      json: '{"a":{"k":1},"b":{"k":2}}',
      expect: [],
    },
    {
      name: "the certStatus regression shape",
      json:
        '{"certStatus":{"a":"x","b":"y"},"other":1,"certStatus":{"c":"z"}}',
      expect: [{ key: "certStatus", pointer: "(root)" }],
    },
    {
      name: "escaped key characters round-trip",
      json: '{"a/b":1,"a/b":2}',
      expect: [{ key: "a/b", pointer: "(root)" }],
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = findDuplicateKeys(c.json);
    const ok =
      got.length === c.expect.length &&
      c.expect.every(
        (e, idx) =>
          got[idx] && got[idx].key === e.key && got[idx].pointer === e.pointer,
      );
    if (!ok) {
      failed += 1;
      console.error(
        `self-test FAIL: ${c.name}\n  expected ${JSON.stringify(c.expect)}\n  got      ${JSON.stringify(got)}`,
      );
    } else {
      console.log(`self-test OK: ${c.name}`);
    }
  }
  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases passed.");
}

const arg = process.argv[2];
if (arg === "--self-test") {
  runSelfTest();
} else {
  runLint();
}
