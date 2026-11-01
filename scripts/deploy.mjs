/**
 * scripts/deploy.mjs — 把 npm 发布的插件复制到 opencode 的 live 插件目录（可选回退）。
 *
 *   注意：推荐安装方式是**在全局 opencode.json 声明 npm 包**（`{"package":"opencode-mnemon"}`），
 *   由 OpenCode 从 npm 拉取，无需本脚本。本脚本仅保留给不使用 npm 声明的环境做本地回退。
 *
 *   node scripts/deploy.mjs            # 复制仓库 mnemon.js -> ~/.config/opencode/plugins/mnemon.js
 *   node scripts/deploy.mjs --check    # 只比对哈希，不写（漂移闸门）
 *   node scripts/deploy.mjs --dry-run  # 打印将要做的事，不写
 *
 * ## 为什么是"复制"而不是符号链接（R11 的教训）
 *
 * 旧版 deploy 用符号链接（编辑仓库即编辑生产）。代价在 2026-10-18 被真实付过一次：
 * 仓库改名 `opencode-mnemon-plugin` → `opencode-mnemon` 后，`~/.config/opencode/plugins/mnemon.js`
 * 变成**悬空链接**，插件静默失效。链接这种东西坏了不报错，只是"东西不见了"。
 *
 * 因此改为复制：live 文件是独立副本，不会因仓库移动/改名而悬空。
 * 代价是可能漂移 → 由 `--check` 的哈希闸门兜住（可接进 `npm test`）。
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(join(HERE, ".."))
const SOURCE = join(PACKAGE_ROOT, "mnemon.js")
const BACKUP_SUFFIX = ".pre-package.bak"

/** live 插件文件：`MNEMON_OPENCODE_PLUGINS` 可覆盖（测试、非标准布局） */
export function targetPath(env = process.env) {
  const override = env.MNEMON_OPENCODE_PLUGINS
  if (typeof override === "string" && override.trim() !== "") return override.trim()
  const home = env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir()
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : join(home, ".config")
  return join(base, "opencode", "plugins", "mnemon.js")
}

export const EXIT = { ok: 0, drift: 1, notDeployed: 2 }

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

/** 目标已存在时的权限沿用；符号链接的 lstat 权限没有意义，一律用 0644 */
function fileMode(existing) {
  if (!existing || existing.isSymbolicLink()) return 0o644
  return existing.mode & 0o777
}

/**
 * 只读检查：live 与包内文件是否一致。不写任何东西（`--check` 与测试都用它）。
 * @returns {{status:'in-sync'|'drift'|'not-deployed'|'refuse', exit:number, source:{path,hash,size}, target:{path,hash,kind,size}, detail?:string}}
 */
export function checkSync({ env = process.env } = {}) {
  const target = targetPath(env)
  let payload
  try {
    if (!statSync(SOURCE).isFile()) throw new Error("not a file")
    payload = readFileSync(SOURCE)
  } catch (error) {
    return {
      status: "refuse",
      exit: EXIT.drift,
      source: { path: SOURCE, hash: "-", size: 0 },
      target: { path: target, hash: null, kind: "missing", size: 0 },
      detail: `source unreadable: ${error.message}`,
    }
  }
  const src = { path: SOURCE, hash: sha256(payload), size: payload.length }

  let existing
  try {
    existing = lstatSync(target, { throwIfNoEntry: false })
  } catch {
    existing = null
  }
  if (!existing) {
    return {
      status: "not-deployed",
      exit: EXIT.notDeployed,
      source: src,
      target: { path: target, hash: null, kind: "missing", size: 0 },
    }
  }
  if (existing.isDirectory()) {
    return {
      status: "drift",
      exit: EXIT.drift,
      source: src,
      target: { path: target, hash: null, kind: "directory", size: 0 },
      detail: "target is a directory; refusing",
    }
  }
  const targetPayload = readFileSync(target)
  const tgt = {
    path: target,
    hash: sha256(targetPayload),
    kind: existing.isSymbolicLink() ? "symlink" : "file",
    size: targetPayload.length,
  }
  const inSync = tgt.hash === src.hash
  return {
    status: inSync ? "in-sync" : "drift",
    exit: inSync ? EXIT.ok : EXIT.drift,
    source: src,
    target: tgt,
    ...(inSync ? {} : { detail: "hash mismatch: live file drifted from package" }),
  }
}

/** 只打印将要做的事（`--dry-run`） */
function dryRun() {
  const target = targetPath()
  const result = checkSync()
  if (result.status === "in-sync") {
    console.log(`in-sync: ${target} already matches ${SOURCE}`)
    return
  }
  console.log(`would deploy: ${SOURCE} -> ${target}`)
  if (result.status === "drift" && result.target?.hash) {
    console.log(`  current live hash: ${result.target.hash}`)
    console.log(`  package   hash:    ${result.source.hash}`)
  }
  if (result.status === "not-deployed") {
    console.log(`  live file missing (not-deployed)`)
  }
}

/** 部署：备份（仅首次）→ 临时文件 → rename 原子替换 */
export function deploy({ env = process.env } = {}) {
  const target = targetPath(env)
  const payload = readFileSync(SOURCE)
  mkdirSync(dirname(target), { recursive: true })

  const existing = lstatSync(target, { throwIfNoEntry: false })

  // 首次部署：把可能存在的旧文件备份为回滚点，之后绝不覆盖备份。
  if (existing) {
    const backup = `${target}${BACKUP_SUFFIX}`
    if (!statSync(backup, { throwIfNoEntry: false })) {
      try {
        renameSync(target, backup)
        console.log(`backed up previous live file -> ${backup}`)
      } catch (error) {
        console.error(`backup failed: ${error.message}`)
        process.exit(EXIT.drift)
      }
    }
  }

  const mode = fileMode(existing)
  const tmp = `${target}.deploy-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, payload, { mode })
    renameSync(tmp, target)
    chmodSync(target, mode)
    console.log(`deployed: ${SOURCE} -> ${target} (${payload.length} bytes)`)
    return { exit: EXIT.ok }
  } catch (error) {
    rmSync(tmp, { force: true })
    console.error(`deploy failed: ${error.message}`)
    return { exit: EXIT.drift }
  }
}

const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : "deploy"

if (mode === "check") {
  const result = checkSync()
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.exit)
} else if (mode === "dry-run") {
  dryRun()
  process.exit(EXIT.ok)
} else {
  const result = deploy()
  process.exit(result.exit)
}