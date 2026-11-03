import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const INIT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "init.mjs"))

let fail = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fail++
}

const run = (cwd, ...args) => spawnSync("node", [INIT, ...args], { cwd, encoding: "utf8", timeout: 60_000 })

// --- fresh project -----------------------------------------------------------
const proj = mkdtempSync(join(tmpdir(), "mnemon-init-"))
const r1 = run(proj)
check("exit 0 on fresh project", r1.status === 0, `exit=${r1.status} ${r1.stderr?.slice(0, 120) ?? ""}`)
check("creates runtime/", existsSync(join(proj, ".mnemon", "runtime")))
check("creates documents/active + archived", existsSync(join(proj, ".mnemon", "documents", "active")) && existsSync(join(proj, ".mnemon", "documents", "archived")))
const index = JSON.parse(readFileSync(join(proj, ".mnemon", "documents", "index.json"), "utf8"))
check("writes empty documents index", Array.isArray(index.documents) && index.documents.length === 0)
const ignore = readFileSync(join(proj, ".mnemon", ".gitignore"), "utf8")
check("nested .gitignore covers data/ + runtime/", ignore.includes("data/") && ignore.includes("runtime/"))
check("never touches .opencode/", !existsSync(join(proj, ".opencode")))

// --- idempotency: pre-seeded index survives -----------------------------------
const seeded = { documents: [{ relativePath: "documents/active/keep.md", title: "keep" }] }
writeFileSync(join(proj, ".mnemon", "documents", "index.json"), JSON.stringify(seeded))
const r2 = run(proj)
check("rerun exit 0", r2.status === 0)
const kept = JSON.parse(readFileSync(join(proj, ".mnemon", "documents", "index.json"), "utf8"))
check("existing index not overwritten", JSON.stringify(kept) === JSON.stringify(seeded))
check("rerun reports already initialized", r2.stdout.includes("already initialized"))

// --- explicit dir arg ----------------------------------------------------------
const other = join(tmpdir(), `mnemon-init-arg-${Date.now()}`)
const r3 = run(proj, other)
check("explicit dir arg honored", r3.status === 0 && existsSync(join(other, ".mnemon", "documents", "index.json")))

// --- legacy duplicate copy warns ----------------------------------------------
mkdirSync(join(proj, ".opencode", "plugins"), { recursive: true })
writeFileSync(join(proj, ".opencode", "plugins", "mnemon.js"), "// stale copy")
const r4 = run(proj)
check("exit stays 0 with legacy copy present", r4.status === 0)
check("warns about Duplicate plugin ID", (r4.stdout + r4.stderr).includes("Duplicate plugin ID"))
check("does not delete the legacy copy itself", existsSync(join(proj, ".opencode", "plugins", "mnemon.js")))

// --- help / version ------------------------------------------------------------
const rh = spawnSync("node", [INIT, "--help"], { encoding: "utf8" })
check("--help exit 0", rh.status === 0 && rh.stdout.includes("Usage:"))
const rv = spawnSync("node", [INIT, "--version"], { encoding: "utf8" })
check("--version prints semver", rv.status === 0 && /^\d+\.\d+\.\d+\s*$/.test(rv.stdout))

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
