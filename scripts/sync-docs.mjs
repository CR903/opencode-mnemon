// Mirror the Trellis task documents into docs/ so the versioned snapshot does
// not silently rot.
//
//   npm run sync:docs          # copy the working copies into docs/
//   npm run sync:docs:check    # report drift, write nothing, non-zero on drift
//   node scripts/sync-docs.mjs --check /path/to/task/dir
//   MNEMON_TASK_DIR=/path/to/task/dir npm run sync:docs
//
// Why a script and not a convention: "remember to sync after editing the task
// docs" has no failure signal. --check does, so it can gate `npm test`.
//
// The task directory is the working copy; docs/ is the snapshot that lives in
// git, because .trellis/ is not version controlled anywhere. Direction is
// one-way on purpose: docs/ is derived, never edited directly.
//
// Not covered: tests/. build-mnemon-test.sh has legitimately diverged (the
// repo copy is newer), so a blanket sync would overwrite it. Reconcile that
// pair by hand, then decide its canonical side.

import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(join(here, "..", "docs"))

const FILES = ["prd.md", "design.md", "implement.md"]

const DEFAULT_TASK_DIR = join(homedir(), "project", "others", ".trellis", "tasks", "10-04-opencode-mnemon-auto-memory")

const args = process.argv.slice(2)
const check = args.includes("--check")
const taskDirArg = args.find((arg) => !arg.startsWith("--"))
const taskDir = resolve(process.env.MNEMON_TASK_DIR ?? taskDirArg ?? DEFAULT_TASK_DIR)

// A missing working copy is not drift: there is nothing to compare against, so
// exit clean rather than failing the check for anyone without that directory.
if (!statSync(taskDir, { throwIfNoEntry: false })?.isDirectory()) {
	console.log(`skipped: task directory not found: ${taskDir}`)
	process.exit(0)
}

if (!check) mkdirSync(docsDir, { recursive: true })

// Compare bytes, not mtimes: a fresh copy of an edited file keeps a new
// timestamp, and a touch should never look like a change.
const drifted = []

for (const file of FILES) {
	const source = join(taskDir, file)
	if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
		console.log(`${file}: missing in task directory`)
		drifted.push(file)
		continue
	}

	const target = join(docsDir, file)
	const same = readFileSync(target, { throwIfNoEntry: false })?.equals(readFileSync(source)) ?? false

	if (check) {
		if (same) console.log(`${file}: ok`)
		else {
			console.log(`${file}: DRIFTED`)
			drifted.push(file)
		}
		continue
	}

	if (same) {
		console.log(`${file}: already in sync`)
		continue
	}

	// Write via temp + rename so docs/<file> is never a half-written file if the
	// copy is interrupted mid-flight.
	const tmp = `${target}.sync-${process.pid}`
	copyFileSync(source, tmp)
	renameSync(tmp, target)
	console.log(`${file}: synced <- ${source}`)
}

if (check && drifted.length > 0) {
	console.error(`\ndocs/ is out of date (${drifted.join(", ")}) — run: npm run sync:docs`)
	process.exit(1)
}