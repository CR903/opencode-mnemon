// One-off measurement for the paraphrase-vs-business split (T1).
// Dumps runtime entries with the current extractMemory verdict plus the raw
// material a paraphrase gate would judge on, so a human can label ~30 rows
// and read off the baseline false-positive rate before any threshold is set.
//
// Usage:
//   sh tests/build-mnemon-test.sh [<src>] && node scripts/measure-paraphrase.mjs [--root <memroot>] [--limit N]
//
// --root defaults to ~/.mnemon (global fallback store).

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { extractMemory } from "/tmp/mnemon-test-plugin.mjs"

const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const root = flag("--root") || join(homedir(), ".mnemon")
const limitArg = Number(flag("--limit"))
const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 40

const doc = JSON.parse(readFileSync(join(root, "runtime", "opencode-memories.json"), "utf8"))
const entries = (doc.entries || []).slice(-limit)

// Ad-hoc 2-gram overlap vs earlier same-session entries (feeds T2 threshold).
function grams(text) {
  const flat = text.replace(/\s+/g, "")
  const out = new Set()
  for (let i = 0; i + 2 <= flat.length && i < 2000; i++) out.add(flat.slice(i, i + 2))
  return out
}
function overlapRatio(text, priors) {
  const g = grams(text)
  if (g.size === 0) return 0
  const pool = new Set()
  for (const p of priors) for (const x of grams(p)) pool.add(x)
  if (pool.size === 0) return 0
  let hit = 0
  for (const x of g) if (pool.has(x)) hit++
  return hit / g.size
}

const seen = new Map() // sessionID -> prior assistant texts
let kept = 0
entries.forEach((entry, i) => {
  const priors = seen.get(entry.sessionID) || []
  const memo = extractMemory(entry, root)
  const ratio = overlapRatio(entry.assistant || "", priors)
  priors.push(entry.assistant || "")
  seen.set(entry.sessionID, priors)
  if (memo) kept++
  const user = (entry.user || "").replace(/\s+/g, " ").slice(0, 80)
  const asst = (entry.assistant || "").replace(/\s+/g, " ").slice(0, 100)
  const q = /[?？]$|吗$|呢$|如何|为什么|对比|区别|是什么/.test((entry.user || "").trim()) ? "Q" : "-"
  console.log(
    `[${i}] ${memo ? `KEEP:${memo.cat}` : "drop"} overlap=${ratio.toFixed(2)} qu=${q} ses=${String(entry.sessionID).slice(-6)}`,
  )
  console.log(`    U: ${user}`)
  console.log(`    A: ${asst}`)
})
console.log(`\nkept ${kept}/${entries.length} — label each KEEP row as paraphrase|business to get the baseline.`)
