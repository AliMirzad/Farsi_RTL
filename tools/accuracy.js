#!/usr/bin/env node
/*
 * Accuracy runner for the direction engine.
 *
 *   node tools/accuracy.js                 report accuracy on the corpus
 *   node tools/accuracy.js --verbose       list every case, not just failures
 *   node tools/accuracy.js extra.json      also run a harvested corpus
 *
 * A harvested corpus comes from the extension's diagnostics mode: turn it
 * on, open a real conversation, copy the JSON, correct any `expect` the
 * engine got wrong, and drop the file in here. That is how this set grows
 * with real text instead of invented examples.
 */
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "engine.js"));

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) files.push(path.join(__dirname, "corpus.json"));

let total = 0, correct = 0;
const byRule = {};
const failures = [];

for (const f of files) {
  const cases = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const c of cases) {
    const v = E.directionOf(c.prose);
    const got = v.dir;
    const want = c.expect === undefined ? null : c.expect;
    total++;
    const ok = got === want;
    if (ok) correct++; else failures.push({ c, got, rule: v.rule, file: path.basename(f) });
    const r = byRule[v.rule] || (byRule[v.rule] = { n: 0, ok: 0 });
    r.n++; if (ok) r.ok++;
    if (verbose) {
      console.log(
        (ok ? "  ok  " : "  FAIL") +
        String(got).padEnd(5) + " r" + v.rule + "  " +
        (c.prose.length > 46 ? c.prose.slice(0, 46) + "…" : c.prose)
      );
    }
  }
}

const pct = total ? (correct / total * 100) : 0;
console.log("\ncases " + total + "   correct " + correct +
            "   accuracy " + pct.toFixed(1) + "%\n");

console.log("per rule:");
for (const k of Object.keys(byRule).sort()) {
  const r = byRule[k];
  console.log("  rule " + k + "  fired " + String(r.n).padStart(3) +
              "   correct " + String(r.ok).padStart(3) +
              "   " + E.RULE_NAMES[k]);
}

if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) {
    console.log("  want " + String(f.c.expect).padEnd(5) +
                " got " + String(f.got).padEnd(5) +
                " via rule " + f.rule + "  (" + f.c.note + ")");
    console.log("    " + f.c.prose);
  }
}
process.exit(failures.length ? 1 : 0);
