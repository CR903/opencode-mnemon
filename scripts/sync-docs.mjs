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
// A check that cannot find its source has NOT verified anything, so it reports
// failure rather than exiting clean. Set MNEMON_TASK_DIR_OPTIONAL=1 to opt out
// on a machine that genuinely has no Trellis task directory.
//
// Not covered: tests/. build-mnemon-test.sh has legitimately diverged (the
// repo copy is newer), so a blanket sync would overwrite it. Reconcile that
// pair by hand, then decide its canonical side.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(join(here, "..", "docs"))

const FILES = ["prd.md", "design.md", "implement.md"]
const TASK_SLUG = "10-04-opencode-mnemon-auto-memory"
const TASKS_ROOT = join(homedir(), "project", "others", ".trellis", "tasks")

const args = process.argv.slice(2)
const check = args.includes("--check")
const taskDirArg = args.find((arg) => !arg.startsWith("--"))
const explicit = process.env.MNEMON_TASK_DIR ?? taskDirArg

const isDir = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false

// The task moves from tasks/<slug>/ to tasks/archive/<YYYY-MM>/<slug>/ when it is
// archived, and that is not a rare event -- it already happened once. So probe
// both locations instead of hardcoding whichever one existed when this was
// written: an archived task is still the live source of docs/.
function resolveTaskDir() {
	if (explicit) return resolve(explicit)

	if (isDir(join(TASKS_ROOT, TASK_SLUG))) return join(TASKS_ROOT, TASK_SLUG)

	// A machine without Trellis at all has no archive dir either; readdir on a
	// missing path throws, which would surface as a stack trace instead of the
	// clean "cannot verify" message below.
	const archive = join(TASKS_ROOT, "archive")
	const periods = isDir(archive)
		? readdirSync(archive, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
		: []

	for (const period of periods) {
		const candidate = join(archive, period, TASK_SLUG)
		if (isDir(candidate)) return candidate
	}

	return join(TASKS_ROOT, TASK_SLUG)
}

const taskDir = resolveTaskDir()

if (!isDir(taskDir)) {
	const how = explicit ? `configured source not found: ${taskDir}` : `task directory not found, looked in ${TASKS_ROOT}/${TASK_SLUG} and ${TASKS_ROOT}/archive/*/${TASK_SLUG}`
	if (process.env.MNEMON_TASK_DIR_OPTIONAL === "1") {
		console.log(`skipped (MNEMON_TASK_DIR_OPTIONAL=1): ${how}`)
		process.exit(0)
	}
	console.error(`cannot verify docs/: ${how}`)
	console.error(`docs/ was NOT compared against any source. Set MNEMON_TASK_DIR, or MNEMON_TASK_DIR_OPTIONAL=1 to accept this.`)
	process.exit(1)
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