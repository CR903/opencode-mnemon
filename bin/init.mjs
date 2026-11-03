#!/usr/bin/env node
/**
 * opencode-mnemon-init — scaffold the per-project memory layer.
 *
 * Creates `<project>/.mnemon/` so the plugin resolves a project-scoped store
 * instead of falling back to the global `~/.mnemon`:
 *
 *   .mnemon/
 *     documents/active/      workspace docs worth indexing (you curate)
 *     documents/archived/
 *     documents/index.json   `{"documents": []}` when new; never overwritten
 *     runtime/               per-session scratch (the plugin owns this)
 *     .gitignore             ignores machine-local data/ + runtime/
 *
 * What it deliberately never touches: `.opencode/` (no plugin/skill copies —
 * the npm package is registered globally, and a second copy under the project
 * trips OpenCode's "Duplicate plugin ID: mnemon" and blocks `plugin update`),
 * and the project root `.gitignore` (scoping lives in `.mnemon/.gitignore`).
 *
 * Usage: npx opencode-mnemon-init [project-dir]
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(`opencode-mnemon-init v${pkg.version}\n\nUsage: opencode-mnemon-init [project-dir]\n\nScaffolds <project-dir>/.mnemon/ (default: cwd). Idempotent: existing\nfiles are never overwritten. Never touches .opencode/ or the root .gitignore.`)
  process.exit(0)
}
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version)
  process.exit(0)
}

const positional = args.find((a) => !a.startsWith("-"))
const target = resolve(positional ?? process.cwd())
const mem = join(target, ".mnemon")

let created = 0
const ensureDir = (dir) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    created++
    console.log(`created ${dir}/`)
  }
}

ensureDir(target)
ensureDir(mem)
ensureDir(join(mem, "runtime"))
ensureDir(join(mem, "documents", "active"))
ensureDir(join(mem, "documents", "archived"))

const indexFile = join(mem, "documents", "index.json")
if (!existsSync(indexFile)) {
  writeFileSync(indexFile, JSON.stringify({ documents: [] }, null, 2) + "\n")
  created++
  console.log(`created ${indexFile}`)
} else {
  console.log(`kept ${indexFile} (already exists, not overwritten)`)
}

const ignoreFile = join(mem, ".gitignore")
if (!existsSync(ignoreFile)) {
  writeFileSync(ignoreFile, "# machine-local mnemon state; documents/ stays versioned\ndata/\nruntime/\n")
  created++
  console.log(`created ${ignoreFile}`)
}

// A project-local plugin/skill copy duplicates the globally registered npm
// package (same id "mnemon") and blocks `opencode plugin update`. Flag it.
for (const legacy of [join(target, ".opencode", "plugins", "mnemon.js"), join(target, ".opencode", "skills", "mnemon")]) {
  if (existsSync(legacy)) {
    console.warn(
      `WARNING: ${legacy} exists and duplicates the global opencode-mnemon package ` +
        `(same plugin id "mnemon" → OpenCode fails with "Duplicate plugin ID"). Remove it ` +
        `or OpenCode refuses to update the plugin.`,
    )
  }
}

// Prove the CLI resolves from here and pre-create data/default/mnemon.db.
const probe = spawnSync("mnemon", ["--data-dir", mem, "status"], { encoding: "utf8", timeout: 30_000 })
if (probe.error || probe.status !== 0) {
  console.warn(`WARNING: could not run "mnemon --data-dir ${mem} status" (${probe.error?.message ?? `exit ${probe.status}`}). Is @mnemon-dev/mnemon on PATH?`)
} else {
  console.log(`store ready: ${mem} (mnemon CLI reachable)`)
}

console.log(created === 0 ? "memory layer already initialized." : `memory layer initialized (${created} new).`)
