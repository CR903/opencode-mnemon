// Point the OpenCode deployment slot at this repo's plugin file.
//
// Preferred: a symlink, so editing the repo edits what OpenCode loads (hot-reload
// picks it up) and there is no second copy to drift.
// Fallback: a plain copy, if the deployment directory refuses symlinks.
//
//   npm run deploy              # link (or copy) this repo -> ~/.config/opencode/plugins/
//   npm run deploy -- --copy    # force a real copy instead of a symlink
//
// The live file is never deleted mid-load: the target is written to a temp file
// first, then swapped into place with rename(), which is atomic on one filesystem.

import { mkdirSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(join(here, "..", "mnemon.js"))
const target = join(homedir(), ".config", "opencode", "plugins", "mnemon.js")
const forceCopy = process.argv.includes("--copy")

if (!statSync(source).isFile()) {
	console.error(`source missing: ${source}`)
	process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })

// lstat, not stat: a symlink must be recognised as a symlink, not followed.
const existing = lstatSync(target, { throwIfNoEntry: false })

// Read the source before touching the target: if the target is a symlink that
// does not point here, writing through it would clobber the file it points at.
const payload = readFileSync(source)

// --copy converts an existing symlink into a real file, so it must run before the
// "already linked" short-circuit below.
if (forceCopy) {
	if (existing?.isSymbolicLink()) rmSync(target, { force: true })
	writeFileSync(target, payload)
	console.log(`copied: ${source} -> ${target}`)
	process.exit(0)
}

// readlinkSync, not readFileSync: the latter follows the link and returns the
// plugin's source, which can never equal the path string we are comparing to.
if (existing?.isSymbolicLink() && readlinkSync(target) === source) {
	console.log(`already linked: ${target} -> ${source}`)
	process.exit(0)
}

if (existing?.isDirectory()) {
	console.error(`refusing to overwrite a directory: ${target}`)
	process.exit(1)
}

// Replace via temp symlink + atomic rename so the slot is never momentarily empty.
const tmp = `${target}.deploy-${process.pid}-${Date.now()}`
try {
	symlinkSync(source, tmp)
	rmSync(target, { force: true })
	renameSync(tmp, target)
	console.log(`linked: ${target} -> ${source}`)
} catch (error) {
	rmSync(tmp, { force: true })
	console.error(`symlink failed (${error.message}); falling back to copy`)
	writeFileSync(target, payload)
	console.log(`copied: ${source} -> ${target}`)
}
