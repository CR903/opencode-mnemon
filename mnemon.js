/**
 * Mnemon plugin for OpenCode V2 (@opencode/plugin 2.0.8).
 *
 * V1 → V2 映射：
 *   - "shell.env"（MNEMON_OPENCODE=1）
 *     → ctx.shell.hook("create.before")，input.env 可直接改写
 *   - "experimental.chat.messages.transform"（recall 上下文注入）
 *     → ctx.session.hook("prompt")，input.prompt.text 可直接改写；
 *     会话 cwd 经 ctx.session.get 解析（与 open-code-review.ts 的 resolveSessionCwd 同款）
 *   - "experimental.session.compacting"（压缩前记忆提示）
 *     → ctx.session.hook("compaction")，向 input.system 追加 system part
 *   - event "session.idle" 仅打日志，无实质功能，V2 不再订阅
 *     （V2 Context.app 无 log 通道；如需 idle 自动 remember 属于功能增强，另行规划）
 *
 * 兼容性：默认导出同时带 setup（V2）与 server（V1），与
 * open-code-review.ts / herdr-agent-state.js 的双版本模式一致。
 * Mnemon 调用由 Bun.spawnSync 改为 node:child_process，便于 bun/node 双 runtime 加载。
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join } from "node:path"

const AUTOMEM_DEBUG_LOG = "/tmp/trellis-plugin-debug.log"
// Append-only with no bound reached 63 MB, and every debugging session greps
// this file. Rotate on size, keeping the previous generations for post-mortem
// context -- a rotation often lands mid-investigation. Generations past
// DEBUG_LOG_KEEP_GENERATIONS are not pruned: the names are never created, so a
// higher-numbered file can only predate a smaller KEEP value.
const DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024
const DEBUG_LOG_KEEP_GENERATIONS = 2

function rotateDebugLog() {
  try {
    const stats = statSync(AUTOMEM_DEBUG_LOG, { throwIfNoEntry: false })
    if (!stats || stats.size < DEBUG_LOG_MAX_BYTES) return
    for (let generation = DEBUG_LOG_KEEP_GENERATIONS - 1; generation >= 1; generation--) {
      const from = `${AUTOMEM_DEBUG_LOG}.${generation}`
      const to = `${AUTOMEM_DEBUG_LOG}.${generation + 1}`
      if (existsSync(from)) renameSync(from, to)
    }
    renameSync(AUTOMEM_DEBUG_LOG, `${AUTOMEM_DEBUG_LOG}.1`)
  } catch {
    // Rotation is best-effort: never let housekeeping break the caller.
  }
}

function debugLog(prefix, ...args) {
  const line = `[${new Date().toISOString()}] [${prefix}] ${args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`
  try {
    rotateDebugLog()
    appendFileSync(AUTOMEM_DEBUG_LOG, line)
  } catch {
    // ignore
  }
}

const MAX_RECALL_CHARS = 4000
const MARKER = "<mnemon_context>"
let SETUP_SEQ = 0
// A 方案的一次性生成入口，setupV2 里按运行时能力赋值（旧版 OpenCode 无 ctx.generate 时为 null）。
let llmGenerate = null
// 模型目录解析器，setupV2 从 ctx.model.list() 注入；拿不到目录时按空目录处理。
let llmCatalog = null

const COMPACTION_TEXT = `## Mnemon Memory

Before compaction completes, preserve durable preferences, decisions, insights, facts, or context with mnemon remember/link when they will improve future continuity. Do not store secrets, credentials, or short-lived operational noise.`

const USAGE_HINT =
  "Use mnemon when it materially improves continuity. After responding, decide whether durable preferences, decisions, insights, facts, or context should be stored with mnemon remember/link."

function resolveProjectDataDir(cwd) {
  if (typeof cwd !== "string" || cwd === "") return null
  const dir = join(cwd, ".mnemon")
  try {
    if (!existsSync(dir)) return null
  } catch {
    return null
  }
  return dir
}

function npmBinary(entry) {
  // `mnemon` on PATH is usually npm's JS launcher, which itself spawns the
  // platform binary. Resolve the native target directly so a timeout kills the
  // real process instead of orphaning it, and so .cmd shims work on Windows.
  // Targets are read from the package manifest rather than duplicated here.
  const root = dirname(dirname(entry))
  const targets = JSON.parse(readFileSync(join(root, "targets.json"), "utf8"))
  const target = targets.find((item) => item.platform === process.platform && item.arch === process.arch)
  if (!target) throw new Error("Unsupported Mnemon platform")
  const require = createRequire(entry)
  const native = dirname(require.resolve(`${target.alias}/package.json`))
  return join(native, target.binary)
}

let MNEMON_BINARY
function mnemonCommand() {
  if (MNEMON_BINARY) return MNEMON_BINARY
  MNEMON_BINARY = "mnemon"
  const delimiter = process.platform === "win32" ? ";" : ":"
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue
    const binary = join(directory, process.platform === "win32" ? "mnemon.exe" : "mnemon")
    if (existsSync(binary)) {
      const resolved = realpathSync(binary)
      const launcher = resolved.endsWith(`${process.platform === "win32" ? "\\" : "/"}bin${process.platform === "win32" ? "\\" : "/"}mnemon.js`)
      if (launcher) {
        try {
          MNEMON_BINARY = npmBinary(resolved)
        } catch {
          MNEMON_BINARY = binary
        }
      } else {
        MNEMON_BINARY = resolved
      }
      break
    }
    if (process.platform === "win32") {
      // Node cannot execute npm's .cmd shim. Locate the launcher without
      // invoking a shell or interpreting user-supplied text.
      for (const modules of [join(directory, "node_modules"), dirname(directory)]) {
        const entry = join(modules, "@mnemon-dev", "mnemon", "bin", "mnemon.js")
        if (existsSync(entry)) {
          try {
            MNEMON_BINARY = npmBinary(entry)
          } catch {
            MNEMON_BINARY = binary
          }
          break
        }
      }
      if (MNEMON_BINARY !== "mnemon") break
    }
  }
  return MNEMON_BINARY
}

function mnemonInvocation(args, options = {}) {
  const cwd = options.cwd || process.cwd()
  const dataDir = options.dataDir || resolveProjectDataDir(cwd)
  const finalArgs = dataDir ? ["--data-dir", dataDir, ...args] : args
  return { cwd, finalArgs }
}

function runMnemon(args, options = {}) {
  const { cwd, finalArgs } = mnemonInvocation(args, options)
  try {
    const proc = spawnSync(mnemonCommand(), finalArgs, {
      cwd,
      encoding: "utf8",
      timeout: options.timeout || 15_000,
    })
    if (proc.status !== 0) return ""
    return (proc.stdout || "").trim()
  } catch {
    return ""
  }
}

// Async variant for background remember: spawnSync would block the event consumer.
function runMnemonAsync(args, options = {}) {
  const { cwd, finalArgs } = mnemonInvocation(args, options)
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (status, extra) => {
      if (settled) return
      settled = true
      resolve({ status, stdout, stderr: stderr || String(extra || "") })
    }
    let child
    try {
      child = spawn(mnemonCommand(), finalArgs, { cwd, encoding: "utf8" })
    } catch (error) {
      finish(-1, error)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
    }, options.timeout || 30_000)
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      finish(-1, error)
    })
    child.on("close", (status) => {
      clearTimeout(timer)
      finish(typeof status === "number" ? status : -1)
    })
  })
}

// ---------------------------------------------------------------------------
// 读侧：运行时记忆（本插件写）+ documents 索引（只读，仅给相对路径）
// ---------------------------------------------------------------------------

const MAX_RUNTIME_SECTION_CHARS = 2048
const RUNTIME_RECENT_COUNT = 5
const DOCS_MAX_SECTION_CHARS = 700
const DOCS_MAX_LIST = 8
// Below this a hit is usually a coincidental 2-gram (e.g. "协议" in an unrelated doc).
const MIN_DOC_SCORE = 3
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "what", "how", "why",
  "继续", "推进", "验证", "确认", "现在", "目前", "一下", "什么", "怎么", "如何", "可以", "请",
])

function clipLine(value, max) {
  if (typeof value !== "string") return ""
  const flat = value.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return ""
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// CJK phrases have no whitespace; add 2-grams so short titles can still match.
function queryTokens(query) {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff-]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
  const out = []
  for (const token of new Set(raw)) {
    out.push(token)
    if (/[\u4e00-\u9fff]/.test(token) && token.length >= 3) {
      for (let i = 0; i + 2 <= token.length; i++) out.push(token.slice(i, i + 2))
    }
  }
  return [...new Set(out)].slice(0, 24)
}

function readRuntimeEntries(root) {
  try {
    const doc = JSON.parse(readFileSync(join(root, "runtime", RUNTIME_FILE), "utf8"))
    if (!doc || !Array.isArray(doc.entries)) return []
    return doc.entries.filter(
      (entry) => entry && typeof entry.assistant === "string" && entry.assistant.trim().length > 0,
    )
  } catch {
    return []
  }
}

function buildRuntimeSection(root, budget) {
  const entries = readRuntimeEntries(root).slice(-RUNTIME_RECENT_COUNT)
  if (entries.length === 0 || budget < 80) return ""
  const head = "Recent runtime turns (workspace-scoped, oldest first):"
  const lines = [head]
  let used = head.length + 1
  for (const entry of entries) {
    const parts = []
    const user = clipLine(entry.user, 260)
    const assistant = clipLine(entry.assistant, 420)
    if (user) parts.push(`user: ${user}`)
    if (assistant) parts.push(`assistant: ${assistant}`)
    if (parts.length === 0) continue
    const line = `- ${clipLine(entry.ts, 19)} ${parts.join(" | ")}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

function readDocumentsIndex(root) {
  try {
    const doc = JSON.parse(readFileSync(join(root, "documents", "index.json"), "utf8"))
    if (!doc || !Array.isArray(doc.documents)) return []
    return doc.documents.filter((item) => item && typeof item.relativePath === "string" && item.relativePath !== "")
  } catch {
    return []
  }
}

function docScore(doc, tokens) {
  if (tokens.length === 0) return 0
  const title = (doc.title || "").toLowerCase()
  const description = (doc.description || "").toLowerCase()
  const paths = (Array.isArray(doc.sourcePaths) ? doc.sourcePaths.join(" ") : "").toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 3
    if (description.includes(token)) score += 2
    if (paths.includes(token)) score += 1
  }
  return score
}

function buildDocsSection(root, query, budget) {
  if (budget < 80) return ""
  const docs = readDocumentsIndex(root)
  if (docs.length === 0) return ""
  const tokens = queryTokens(query)
  const hits = docs
    .map((doc) => ({ doc, score: docScore(doc, tokens) }))
    .filter((hit) => hit.score >= MIN_DOC_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, DOCS_MAX_LIST)
  if (hits.length === 0) return ""
  const lines = ["Workspace documents (read-only; relative paths, read on demand):"]
  let used = lines[0].length + 1
  for (const { doc, score } of hits) {
    const line = `- ${doc.relativePath}${doc.title ? ` — ${clipLine(doc.title, 60)}` : ""} (${score})`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

function buildRecallContext(query, cwd) {
  const status = runMnemon(["status"], { cwd })
  const recall = query.trim() === "" ? "" : runMnemon(["recall", query, "--limit", "5"], { cwd })
  const sections = []
  if (status) sections.push(`Status:\n${status}`)
  if (recall) sections.push(`Relevant recall:\n${recall.slice(0, MAX_RECALL_CHARS)}`)
  const root = resolveMemoryRoot(cwd)
  const docs = buildDocsSection(root, query, DOCS_MAX_SECTION_CHARS)
  if (docs) sections.push(docs)
  const runtime = buildRuntimeSection(root, MAX_RUNTIME_SECTION_CHARS - docs.length)
  if (runtime) sections.push(runtime)
  sections.push(USAGE_HINT)
  return `\n\n<mnemon_context>\n${sections.join("\n\n")}\n</mnemon_context>\n\n`
}

async function resolveSessionCwd(ctx, sessionID, fallback) {
  try {
    const session = await ctx.session.get({ sessionID })
    const directory = session?.location?.directory ?? session?.directory ?? fallback
    const subpath = session?.subpath
    if (typeof directory !== "string" || directory === "") return fallback
    if (typeof subpath !== "string" || subpath === "") return directory
    return `${directory}/${subpath}`.replace(/\/+/g, "/")
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// V1 server hooks（保留兼容）
// ---------------------------------------------------------------------------

const MnemonPlugin = async ({ directory, client }) => {
  if (hooksDisabled()) {
    await client?.app?.log?.({
      body: {
        service: "mnemon",
        level: "info",
        message: "Mnemon OpenCode plugin skipped - TRELLIS_HOOKS disabled",
      },
    })
    return {}
  }
  await client?.app?.log?.({
    body: {
      service: "mnemon",
      level: "info",
      message: "Mnemon OpenCode plugin loaded",
    },
  })

  return {
    "shell.env": async (_input, output) => {
      if (!output.env) output.env = {}
      output.env.MNEMON_OPENCODE = "1"
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const current = lastUserMessage(output)
      if (!current) return
      if (current.text.includes(MARKER)) return
      prependText(current.parts, buildRecallContext(current.text, directory))
    },

    "experimental.session.compacting": async (_input, output) => {
      if (!Array.isArray(output.context)) output.context = []
      output.context.push(COMPACTION_TEXT)
    },

    event: async ({ event }) => {
      if (event?.type !== "session.idle") return
      await client?.app?.log?.({
        body: {
          service: "mnemon",
          level: "info",
          message: "OpenCode session idle; evaluate whether durable memory should be written with mnemon",
        },
      })
    },
  }
}

function textFromPart(part) {
  if (!part || typeof part !== "object") return ""
  if (part.type === "text" && typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function lastUserMessage(output) {
  const messages = Array.isArray(output?.messages) ? output.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const role = msg?.info?.role || msg?.role
    if (role !== "user") continue
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    return { msg, parts, text: parts.map(textFromPart).filter(Boolean).join("\n") }
  }
  return null
}

function prependText(parts, text) {
  if (!Array.isArray(parts) || text.trim() === "") return
  parts.unshift({ type: "text", text })
}

// ---------------------------------------------------------------------------
// V2 setup
// ---------------------------------------------------------------------------

async function setupV2(ctx) {
  if (hooksDisabled()) {
    debugLog("mnemon-auto", "setup: skipped - TRELLIS_HOOKS disabled (read + write off)")
    return
  }
  // A 方案（步骤 5）：一次性文本生成入口。ctx.generate.text 不经过 session prompt，
  // 因此不触发本插件的 prompt hook；写侧另用 LLM_EXTRACT_MARKER 兜底防递归。
  setLlmGenerate(ctx.generate && typeof ctx.generate.text === "function" ? (input) => ctx.generate.text(input) : null)
  // 模型目录：ctx.model.list() 返回 { location, data }。只取 data 数组，解析失败按空目录处理。
  setLlmCatalog(ctx.model && typeof ctx.model.list === "function" ? () => ctx.model.list().then((value) => value?.data).catch(() => []) : null)
  // 1. shell 环境变量：替代 V1 "shell.env"
  await ctx.shell.hook("create.before", (input) => {
    input.env.MNEMON_OPENCODE = "1"
  })

  // 2. recall 上下文注入：替代 V1 "experimental.chat.messages.transform"
  // 同时记录本轮 user 文本，供 text.ended 配对写运行时记忆
  const setupId = ++SETUP_SEQ
  const lastUserPrompt = new Map()
  await ctx.session.hook("prompt", async (input) => {
    const text = input?.prompt?.text ?? ""
    const sid = input?.sessionID
    if (typeof sid !== "string" || sid === "" || typeof text !== "string") {
      debugLog(
        "mnemon-auto",
        "prompt no-stash setup:",
        setupId,
        "sessionID:",
        typeof sid,
        "text:",
        typeof text,
      )
      return
    }
    const cwd = await resolveSessionCwd(ctx, sid, ctx.location.directory)
    const userText = unescapeUserText(text)
    lastUserPrompt.set(sid, userText)
    if (lastUserPrompt.size > 128) lastUserPrompt.delete(lastUserPrompt.keys().next().value)
    if (autOMEMEnabled()) writePendingPrompt(resolveMemoryRoot(cwd), sid, userText)
    debugLog(
      "mnemon-auto",
      "prompt stash setup:",
      setupId,
      "session:",
      sid,
      "chars:",
      userText.length,
      "marker:",
      text.includes(MARKER),
      "keys:",
      Object.keys(input).join(","),
      "promptKeys:",
      Object.keys(input.prompt ?? {}).join(","),
    )
    if (text.includes(MARKER)) return
    const injected = buildRecallContext(userText, cwd)
    input.prompt.text = injected + userText
    debugLog(
      "mnemon-auto",
      "prompt inject setup:",
      setupId,
      "session:",
      sid,
      "injectedChars:",
      injected.length,
    )
  })

  // 3. 压缩前记忆提示：替代 V1 "experimental.session.compacting"
  await ctx.session.hook("compaction", (input) => {
    if (!Array.isArray(input.system)) return
    input.system.push({ type: "text", text: COMPACTION_TEXT })
  })

  // 4. 自动记录：后台订阅会话事件（对标 dsh 主动记录；步骤 2 先落文件层）
  // MNEMON_AUTOMEM=0 只关写侧（运行时记忆 + remember），读侧 recall 注入保留
  if (!autOMEMEnabled()) {
    debugLog("mnemon-auto", "setup:", setupId, "autOMEM disabled (MNEMON_AUTOMEM=0): write side off, read side kept")
    return () => {}
  }
  const controller = new AbortController()
  consumeSessionEvents(ctx, controller.signal, lastUserPrompt, setupId).catch((error) => {
    debugLog("mnemon-auto", "event consumer exited:", error?.message ?? String(error))
  })
  return () => controller.abort()
}

const MAX_RUNTIME_ENTRIES = 50
const MAX_RUNTIME_TEXT_CHARS = 2000
const MIN_RUNTIME_TEXT_CHARS = 20
// OpenCode keeps its own runtime file; dsh-mnemon owns runtime/memories.json (different schema).
const RUNTIME_FILE = "opencode-memories.json"
const RUNTIME_LOCK = ".opencode-memories.lock"
const PENDING_DIR = "pending"
// A 方案生成的文本自带此标记。写侧据此跳过，兜底防递归（LLM 抽取误回灌成本轮记忆）。
const LLM_EXTRACT_MARKER = "[mnemon-extract]"

function resolveMemoryRoot(cwd) {
  const project = resolveProjectDataDir(cwd)
  if (project) return project
  return join(process.env.HOME || "", ".mnemon")
}

// V2 prompt hooks deliver the prompt as a JSON-encoded string ("..."); unwrap it once.
function unescapeUserText(value) {
  if (typeof value !== "string") return ""
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === "string") return parsed
    } catch {
      // not valid JSON: keep raw
    }
  }
  return value
}

function pendingPromptFile(root, sessionID) {
  return join(root, "runtime", PENDING_DIR, `${sessionID}.json`)
}

// One file per session; drop anything older than a day so it cannot grow unbounded.
function prunePendingDir(dir) {
  try {
    const cutoff = Date.now() - 86_400_000
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      try {
        const file = join(dir, ent.name)
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// Shared across OpenCode processes, so the single writer always has the user prompt.
function writePendingPrompt(root, sessionID, user) {
  try {
    const file = pendingPromptFile(root, sessionID)
    mkdirSync(dirname(file), { recursive: true })
    writeJsonAtomic(file, { sessionID, user, ts: new Date().toISOString() })
    prunePendingDir(dirname(file))
  } catch {
    // best effort
  }
}

function takePendingPrompt(root, sessionID) {
  try {
    const file = pendingPromptFile(root, sessionID)
    const info = JSON.parse(readFileSync(file, "utf8"))
    rmSync(file, { force: true })
    return typeof info?.user === "string" ? info.user : ""
  } catch {
    return null // no pending prompt for this session
  }
}

const RUNTIME_LOCK_STALE_MS = 10_000
const RUNTIME_LOCK_RETRY_MS = 50
const RUNTIME_LOCK_MAX_ATTEMPTS = 20

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function writeJsonAtomic(file, doc) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2))
  renameSync(tmp, file)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockOwnerStale(lockFile) {
  try {
    const info = JSON.parse(readFileSync(lockFile, "utf8"))
    const age = Date.now() - (Number(info?.ts) || 0)
    if (age < 0 || age > RUNTIME_LOCK_STALE_MS) return true
    return !pidAlive(info?.pid)
  } catch {
    return true // unreadable lock: take over
  }
}

// OpenCode runs the plugin once per process (TUI + server + each `opencode run`), and
// every process subscribes to the same event bus. Locking is per-append and released
// after the write, so a busy session keeps writing turn after turn.
function acquireWriterLock(runtimeDir) {
  const lockFile = join(runtimeDir, RUNTIME_LOCK)
  const take = () => {
    try {
      const fd = openSync(lockFile, "wx")
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }))
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
  for (let attempt = 0; attempt < RUNTIME_LOCK_MAX_ATTEMPTS; attempt++) {
    if (take()) return true
    if (lockOwnerStale(lockFile)) {
      rmSync(lockFile, { force: true })
      continue
    }
    sleep(RUNTIME_LOCK_RETRY_MS)
  }
  return false
}

function releaseWriterLock(runtimeDir) {
  try {
    const lockFile = join(runtimeDir, RUNTIME_LOCK)
    const info = JSON.parse(readFileSync(lockFile, "utf8"))
    if (info?.pid === process.pid) rmSync(lockFile, { force: true })
  } catch {
    // not ours or already gone
  }
}

function appendRuntimeMemory(root, entry) {
  if (!entry || typeof entry.sessionID !== "string" || typeof entry.assistant !== "string") return false
  // A 方案生成的文本不得回流成本轮记忆（防递归）
  if (entry.assistant.includes(LLM_EXTRACT_MARKER)) return false
  const runtimeDir = join(root, "runtime")
  try {
    mkdirSync(runtimeDir, { recursive: true })
  } catch {
    return false
  }
  if (!acquireWriterLock(runtimeDir)) return false
  const file = join(runtimeDir, RUNTIME_FILE)
  try {
    let doc = { version: 1, entries: [] }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      if (parsed && Array.isArray(parsed.entries)) doc = parsed
    } catch {
      // missing or corrupt: start fresh
    }
    // Consume the pending prompt inside the locked region: a peer that loses the lock
    // race must not delete a pending file whose user text it will never get to write.
    const pending = entry.user === "" ? takePendingPrompt(root, entry.sessionID) : null
    entry.user = entry.user || (pending ?? "")
    const startsTurn = entry.user !== "" || pending !== null

    const existing = doc.entries.find(
      (item) => item.sessionID === entry.sessionID && item.assistant === entry.assistant,
    )
    if (existing) {
      if (!existing.user && entry.user) {
        existing.user = entry.user // a peer wrote the entry first without the prompt
        writeJsonAtomic(file, doc)
      }
      return true // duplicate delivery from a peer process: skip
    }
    if (!startsTurn) {
      const last = doc.entries[doc.entries.length - 1]
      if (last && last.sessionID === entry.sessionID) {
        if (!last.assistant.includes(entry.assistant)) {
          // another streamed segment of the same turn: fold it in instead of adding noise
          last.assistant = `${last.assistant || ""}\n${entry.assistant}`.slice(0, MAX_RUNTIME_TEXT_CHARS)
          writeJsonAtomic(file, doc)
        }
        return true // continuation segment: merged, or already present from a peer
      }
    }
    doc.entries.push(entry)
    if (doc.entries.length > MAX_RUNTIME_ENTRIES) {
      doc.entries = doc.entries.slice(doc.entries.length - MAX_RUNTIME_ENTRIES)
    }
    writeJsonAtomic(file, doc)
    return true
  } catch {
    return false
  } finally {
    releaseWriterLock(runtimeDir)
  }
}
function clipText(value, limit = MAX_RUNTIME_TEXT_CHARS) {
  if (typeof value !== "string") return ""
  if (value.length <= limit) return value
  return value.slice(0, limit)
}

// ---------------------------------------------------------------------------
// 写侧（方案 B，规则抽取）：已定稿的运行时条目 → mnemon remember
// ---------------------------------------------------------------------------

const REMEMBER_MIN_AGE_MS = 60_000
const REMEMBER_BATCH = 3
const REMEMBER_MIN_TOTAL_CHARS = 24
const REMEMBER_SUBSTANTIVE_CHARS = 60
const REMEMBER_MAX_FENCE_RATIO = 0.7
const REMEMBER_ASSISTANT_CHARS = 700
const REMEMBER_USER_CHARS = 150
const REMEMBER_HEADLINE_CHARS = 110
const REMEMBER_MAX_ENTITIES = 8
const REMEMBER_MIN_IMP = 3
const REMEMBER_BUSY_RETRY_MS = 350
// The final turn of a session never gets a follow-up event; revisit after it has aged past the claim window.
const REMEMBER_TAIL_DELAY_MS = 75_000
// A claim is a lock that can be lost if the process dies mid-sweep. Past this lease another process may steal it.
// Well above the worst case (REMEMBER_BATCH x attempts x CLI timeout) so a live sweep is never stolen.
const REMEMBER_CLAIM_LEASE_MS = 300_000

// A 方案（步骤 5）：规则没抽到时的 LLM 补抽。默认关闭，两条开关任一生效即开：
//   1. <root>/opencode-llm-extract 标记文件 — 按项目生效，touch 即开、删除即关，无需重启进程。
//      文件内容非空时同时作为模型 ID（touch 成空文件则用默认模型）。
//   2. MNEMON_LLM_EXTRACT=1 — 进程级 env，需重启 OpenCode 才生效。
// MNEMON_LLM_EXTRACT=0 是显式总闸，优先级最高，可压过标记文件。
// 只在 B 方案明确判空时补一次，网络调用不进写者锁，失败静默回退到规则结果。
const LLM_ENABLE_FLAG = "opencode-llm-extract"
const LLM_ENABLE_ENV = "MNEMON_LLM_EXTRACT"
const LLM_MODEL_ENV = "MNEMON_LLM_MODEL"
// ctx.generate.text 要 { id, modelID, providerID } 且必须在模型目录里；"provider/model" 字符串不认，
// 只给 { id } 会报 Missing key at ["model"]["providerID"]。按顺序取第一个目录里存在的模型，
// 最后一项是唯一实测可用的兜底（探测确认 opencode-go/longcat-2.5-preview-free 返回 {"text":"OK"}）。
const LLM_MODEL_CHAIN = [
  "opencode-go/qwen3.8-flash",
  "opencode-go/deepseek-v4-flash",
  "opencode-gemini-3.5-flash-lite",
  "opencode-go/longcat-2.5-preview-free",
]
const LLM_TIMEOUT_MS = 25_000
const LLM_SUMMARY_CHARS = REMEMBER_HEADLINE_CHARS
const LLM_DETAIL_CHARS = REMEMBER_ASSISTANT_CHARS
const LLM_MAX_ENTITIES = 6

// Higher entries win; a turn is filed as the strongest signal it carries.
const REMEMBER_RULES = [
  {
    cat: "preference",
    imp: 5,
    words: ["偏好", "不要", "别再", "以后都", "总是用", "一贯", "prefer", "always", "never", "instead of"],
  },
  {
    cat: "decision",
    imp: 5,
    words: ["决定", "结论是", "采用", "改用", "换成", "定为", "decided", "decision", "go with", "will use"],
  },
  {
    cat: "insight",
    imp: 4,
    words: ["根因", "坑", "注意", "避免", "否则会", "会导致", "之所以", "root cause", "lesson", "gotcha", "turns out"],
  },
  {
    cat: "fact",
    imp: 4,
    words: ["实测", "验证", "报错", "HTTP", "版本", "端口", "verified", "returns", "version", "port"],
  },
]

function autOMEMEnabled() {
  return process.env.MNEMON_AUTOMEM !== "0"
}

// 与 BalanceDeck 的 session-start / inject-workflow-state / inject-subagent-context 同款总闸。
// 关掉时读写两侧都不注册；MNEMON_AUTOMEM=0 只关写侧、保留读侧 recall 注入。
function hooksDisabled() {
  return process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1"
}

function collapseText(value) {
  if (typeof value !== "string") return ""
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " [代码块] ").replace(/`([^`\n]{1,64})`/g, "$1")
}

function fenceRatio(text) {
  const total = text.length
  if (total < 40) return 0
  const fences = text.match(/```[\s\S]*?(?:```|$)/g)
  if (!fences) return 0
  return fences.reduce((sum, fence) => sum + fence.length, 0) / total
}

function headlineOf(text) {
  const firstLine = (text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) || "").replace(/^(?:[-*]+\s+|\d+[.)]\s+|\d+、)/, "")
  // Guard dots inside identifiers and version numbers ("0.2.10", "src/a.ts") so they are not read as sentence ends.
  const guarded = firstLine.replace(/(?<=\w)\.(?=\w)/g, "\u0000")
  const firstSentence = (guarded.split(/[。！？.!?\n]/)[0] || guarded).replace(/\u0000/g, ".")
  return clipText(firstSentence.trim(), REMEMBER_HEADLINE_CHARS)
}

function extractEntities(text) {
  const found = []
  const push = (value) => {
    const candidate = value.trim()
    if (candidate.length < 2 || candidate.length > 64) return
    if (/^[\W_]+$/.test(candidate)) return
    if (found.includes(candidate)) return
    found.push(candidate)
  }
  for (const match of text.matchAll(/`([^`\n]{1,64})`/g)) push(match[1])
  for (const match of text.matchAll(/https?:\/\/[^\s)`]+/g)) push(match[0].replace(/[).,;]+$/, ""))
  for (const match of text.matchAll(/(?:[A-Za-z0-9._-]+\/){1,4}[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}/g)) push(match[0])
  for (const match of text.matchAll(/\b[A-Z][a-z0-9]{1,}(?:[A-Z][a-z0-9]{0,}){1,4}\b/g)) push(match[0])
  for (const match of text.matchAll(/\b[A-Z]{3,}\b/g)) push(match[0])
  for (const match of text.matchAll(/\b\d+\.\d+(?:\.\d+)+\b/g)) push(match[0])
  // A lower-case tool or flag named inside CJK prose ("用 tabs 而不是 spaces") is a concrete anchor too.
  for (const match of text.matchAll(/[\u4e00-\u9fff]\s+([A-Za-z][A-Za-z0-9._-]{2,})(?!\s*:\/\/)\b/g)) push(match[1])
  return found.slice(0, REMEMBER_MAX_ENTITIES)
}

// ASCII words match on word boundaries ("port" must not fire inside "important"); CJK words stay substring matches.
function hasWord(lowered, word) {
  const needle = word.toLowerCase()
  if (!/[a-z]/.test(needle)) return lowered.includes(needle)
  return new RegExp(`\\b${needle}\\b`).test(lowered)
}

function classifyMemory(text) {
  const lowered = text.toLowerCase()
  for (const rule of REMEMBER_RULES) {
    if (rule.words.some((word) => hasWord(lowered, word))) return rule
  }
  return null
}

function hashText(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

// Returns null when the turn is not worth a durable memory.
function extractMemory(entry, root) {
  const user = collapseText(entry?.user || "")
  const assistant = collapseText(entry?.assistant || "")
  const rule = classifyMemory(`${user}\n${assistant}`)
  if (!rule || rule.imp < REMEMBER_MIN_IMP) return null
  if (fenceRatio(assistant) > REMEMBER_MAX_FENCE_RATIO) return null
  const total = user.length + assistant.length
  if (total < REMEMBER_MIN_TOTAL_CHARS) return null
  const entities = extractEntities(`${user}\n${assistant}`)
  // Without something concrete to point at, only a substantive passage is worth keeping.
  if (entities.length === 0 && total < REMEMBER_SUBSTANTIVE_CHARS) return null
  const prose = stripCodeBlocks(assistant)
  const fromUser = rule.words.some((word) => hasWord(user.toLowerCase(), word))
  const userLine = user ? `\n用户：${clipText(user, REMEMBER_USER_CHARS)}` : ""
  const content = `[${rule.cat}] ${headlineOf(fromUser ? user : prose)}${userLine}\n要点：${clipText(prose, REMEMBER_ASSISTANT_CHARS)}`
  return {
    content,
    cat: rule.cat,
    imp: rule.imp,
    entities,
    tags: ["opencode", basename(dirname(root)) || "workspace"],
    key: hashText(content),
  }
}

// Resolves the switch and the model once per candidate entry. Returns null when the LLM path is off.
// Computed from disk each time so `touch`/`rm` of the flag file takes effect on the next sweep,
// without restarting the process that holds the env.
function llmExtractConfig(root) {
  const env = process.env[LLM_ENABLE_ENV]
  if (env === "0") return null
  const flagFile = join(root, LLM_ENABLE_FLAG)
  const fileOn = existsSync(flagFile)
  let flagModel = ""
  if (fileOn) {
    try {
      flagModel = readFileSync(flagFile, "utf8").trim()
    } catch {
      flagModel = ""
    }
  }
  if (env !== "1" && !fileOn) return null
  return {
    source: env === "1" ? "env" : "file",
    model: (process.env[LLM_MODEL_ENV] ?? "").trim() || flagModel,
  }
}

// ctx.model.list() 返回 { location, data }，这里只取目录数组；拿不到就返回空数组。
function setLlmCatalog(fn) {
  llmCatalog = typeof fn === "function" ? fn : null
}

// "provider/model" → { id, modelID, providerID }。id 是裸 modelID：传完整名会被拼成 provider/provider/model。
function modelRefFromName(name) {
  if (typeof name !== "string") return null
  const value = name.trim()
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return null
  const providerID = value.slice(0, slash)
  const modelID = value.slice(slash + 1)
  return { id: modelID, providerID, modelID }
}

// 配置值可能指向目录里不存在的模型（项目级 provider 不在全局目录），逐个降级。
// 目录为空时跳过校验直接信任配置；全都不中返回 null，由调用侧静默放弃。
function pickModelRef(models, wanted) {
  const list = Array.isArray(models) ? models : []
  for (const name of [wanted, ...LLM_MODEL_CHAIN]) {
    if (!name) continue
    const ref = modelRefFromName(name)
    if (!ref) continue
    if (list.length === 0 || list.some((model) => model?.providerID === ref.providerID && model?.modelID === ref.modelID)) {
      return ref
    }
  }
  return null
}

// Single write path for the generation seam: setupV2 sets it from ctx.generate, tests inject a fake.
function setLlmGenerate(fn) {
  llmGenerate = typeof fn === "function" ? fn : null
}

function withTimeoutMs(promise, ms, label) {
  const guard = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (typeof timer.unref === "function") timer.unref()
  })
  return Promise.race([promise, guard])
}

function buildLlmPrompt(user, assistant) {
  return [
    `${LLM_EXTRACT_MARKER} 你是对话记忆的抽取器。判断下面这一轮对话是否值得作为长期记忆保存。`,
    "",
    "<对话>",
    `用户：${user}`,
    `助手：${assistant}`,
    "</对话>",
    "",
    "判断标准：",
    "- 值得保存：明确的偏好或决定；踩过的坑与根因结论；环境事实（工具、版本、路径、端口、开关）；后续必须记住的约束。",
    "- 不值得保存：寒暄与确认；纯执行过程的复述；报错堆栈；没有结论的尝试；重新查证就能拿到的临时状态。",
    "",
    "输出要求：只输出一个 JSON 对象，不要代码围栏，不要任何解释。",
    "- 不保存时输出 {\"keep\":false} 。",
    `- 保存时 summary 用一句话概括（${LLM_SUMMARY_CHARS} 字以内），detail 给出支撑细节（${LLM_DETAIL_CHARS} 字以内）。`,
    "- 关键实体原文必须保留：命令、路径、URL、版本号、开关名一字不改，不翻译不改写。",
    "- cat 取 fact / preference / insight / decision 之一。",
    "- imp 取 1-5：5 明确的偏好或决定，4 重要结论或事实，3 一般事实。",
    `- entities 只填正文里真实出现过的实体，最多 ${LLM_MAX_ENTITIES} 个。`,
    "",
    '{"keep":true,"cat":"preference","imp":5,"summary":"...","detail":"...","entities":["..."]}',
  ].join("\n")
}

// The model may wrap the JSON in prose or a fence; keep only the outermost object.
function parseLlmReply(text) {
  if (typeof text !== "string") return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

// Cheap material check shared with the rules path: is there enough readable text for a model to judge?
function llmWorthyEntry(entry) {
  const user = collapseText(entry?.user || "")
  const assistant = collapseText(entry?.assistant || "")
  if (assistant.includes(LLM_EXTRACT_MARKER)) return false
  if (user.length + assistant.length < REMEMBER_MIN_TOTAL_CHARS) return false
  if (fenceRatio(assistant) > REMEMBER_MAX_FENCE_RATIO) return false
  return true
}

// A 方案：same memo shape as extractMemory, so the writer, the dedupe key and the CLI args stay unchanged.
async function llmExtractMemory(entry, root) {
  const config = llmExtractConfig(root)
  if (!config || typeof llmGenerate !== "function") return null
  if (!llmWorthyEntry(entry)) return null
  const model = pickModelRef(typeof llmCatalog === "function" ? await llmCatalog() : [], config.model)
  if (!model) {
    debugLog("mnemon-auto", "llm extract skipped via:", config.source, "reason: no model resolvable from catalog")
    return null
  }
  const modelName = `${model.providerID}/${model.modelID}`
  const user = clipText(collapseText(entry.user || ""), REMEMBER_USER_CHARS)
  const assistant = clipText(collapseText(entry.assistant || ""), REMEMBER_ASSISTANT_CHARS)
  let reply
  try {
    reply = await withTimeoutMs(
      llmGenerate({ prompt: buildLlmPrompt(user, assistant), model }),
      LLM_TIMEOUT_MS,
      "llm-extract",
    )
  } catch (error) {
    debugLog("mnemon-auto", "llm remember skipped via:", config.source, "model:", modelName, String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 120))
    return null
  }
  const raw = parseLlmReply(typeof reply?.text === "string" ? reply.text : "")
  if (!raw || raw.keep !== true) {
    // Visible so a production run can show the model actually declined, not silently no-oped.
    debugLog("mnemon-auto", "llm extract drop via:", config.source, "model:", modelName, "session:", entry.sessionID, "keep:", String(raw?.keep ?? "unparsed"))
    return null
  }
  const summary = clipText(String(raw.summary ?? "").trim(), LLM_SUMMARY_CHARS)
  const detail = clipText(String(raw.detail ?? "").trim(), LLM_DETAIL_CHARS)
  // The floor applies to the model's total material, not to the headline alone:
  // a one-line summary is expected to be short, the rules path gates the same way on combined length.
  if (summary.length === 0 || summary.length + detail.length < REMEMBER_MIN_TOTAL_CHARS) return null
  const categories = ["fact", "preference", "insight", "decision"]
  const cat = categories.includes(raw.cat) ? raw.cat : "fact"
  const imp = Number.isFinite(Number(raw.imp))
    ? Math.max(REMEMBER_MIN_IMP, Math.min(5, Math.round(Number(raw.imp))))
    : REMEMBER_MIN_IMP
  const entities = (Array.isArray(raw.entities) ? raw.entities : [])
    .map((value) => clipText(String(value).trim(), 64))
    .filter((value) => value.length >= 2 && !/^[\W_]+$/.test(value))
    .slice(0, LLM_MAX_ENTITIES)
  const userLine = user ? `\n用户：${user}` : ""
  const content = `[${cat}] ${summary}${userLine}\n要点：${detail}`
  debugLog("mnemon-auto", "llm extract ok via:", config.source, "model:", modelName, "session:", entry.sessionID, "cat:", cat, "imp:", imp, "chars:", content.length)
  return {
    content,
    cat,
    imp,
    entities,
    tags: ["opencode", basename(dirname(root)) || "workspace"],
    key: hashText(content),
  }
}

function rememberToMnemon(root, memo) {
  const args = ["remember", memo.content, "--cat", memo.cat, "--imp", String(memo.imp), "--source", "agent", "--tags", memo.tags.join(",")]
  if (memo.entities.length > 0) args.push("--entities", memo.entities.join(","))
  return (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const detail = await runMnemonAsync(args, { dataDir: root, timeout: 30_000 })
      if (detail.status === 0) return { ok: true, output: detail.stdout.trim().slice(0, 200) }
      const message = (detail.stderr || detail.stdout || "").trim()
      if (attempt === 1 && /locked|busy/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, REMEMBER_BUSY_RETRY_MS))
        continue
      }
      return { ok: false, error: (message || `exit ${detail.status}`).slice(0, 200) }
    }
    return { ok: false, error: "busy after retry" }
  })()
}

function readRuntimeDoc(root) {
  try {
    const doc = JSON.parse(readFileSync(join(root, "runtime", RUNTIME_FILE), "utf8"))
    if (doc && Array.isArray(doc.entries)) return doc
  } catch {
    // missing or corrupt
  }
  return { version: 1, entries: [] }
}

function entryAgeOk(entry) {
  const parsed = Date.parse(entry?.ts)
  if (!Number.isFinite(parsed)) return false
  return parsed < Date.now() - REMEMBER_MIN_AGE_MS
}

// A claim without a fresh lease belongs to a process that died mid-sweep; reclaim it rather than letting it stall forever.
function claimStale(entry) {
  if (entry?.remembered !== "claimed") return false
  const at = Date.parse(entry.claimedAt)
  return !Number.isFinite(at) || at < Date.now() - REMEMBER_CLAIM_LEASE_MS
}

// Claim finalized entries under the writer lock so exactly one process files each one.
function claimRememberable(root) {
  const runtimeDir = join(root, "runtime")
  if (!acquireWriterLock(runtimeDir)) return null
  const file = join(runtimeDir, RUNTIME_FILE)
  try {
    const doc = readRuntimeDoc(root)
    const seenKeys = new Set(
      doc.entries.filter((entry) => typeof entry.rememberKey === "string" && entry.rememberKey !== "").map((entry) => entry.rememberKey),
    )
    const picked = []
    for (const entry of doc.entries) {
      if (picked.length >= REMEMBER_BATCH) break
      if (entry.remembered && !claimStale(entry)) continue
      if (entryAgeOk(entry)) picked.push(entry)
    }
    if (picked.length === 0) return null
    const now = new Date().toISOString()
    for (const entry of picked) {
      entry.remembered = "claimed"
      entry.claimedAt = now
    }
    writeJsonAtomic(file, doc)
    return { picked, seenKeys }
  } catch {
    return null
  } finally {
    releaseWriterLock(runtimeDir)
  }
}

function markRemembered(root, entry, remembered, key) {
  const runtimeDir = join(root, "runtime")
  if (!acquireWriterLock(runtimeDir)) return false
  const file = join(runtimeDir, RUNTIME_FILE)
  try {
    const doc = readRuntimeDoc(root)
    const target = doc.entries.find((item) => item.sessionID === entry.sessionID && item.ts === entry.ts)
    if (!target) return false
    target.remembered = remembered
    if (typeof key === "string" && key !== "") target.rememberKey = key
    writeJsonAtomic(file, doc)
    return true
  } catch {
    return false
  } finally {
    releaseWriterLock(runtimeDir)
  }
}

async function sweepAndRemember(root, setupId) {
  const claim = claimRememberable(root)
  if (!claim) return 0
  let written = 0
  for (const entry of claim.picked) {
    try {
      const memo = extractMemory(entry, root) ?? (await llmExtractMemory(entry, root))
      if (!memo) {
        markRemembered(root, entry, true)
        debugLog("mnemon-auto", "remember skip setup:", setupId, "session:", entry.sessionID, "reason: below threshold")
        continue
      }
      if (claim.seenKeys.has(memo.key)) {
        markRemembered(root, entry, true, memo.key)
        debugLog("mnemon-auto", "remember skip setup:", setupId, "session:", entry.sessionID, "reason: duplicate")
        continue
      }
      const result = await rememberToMnemon(root, memo)
      markRemembered(root, entry, result.ok, memo.key)
      if (result.ok) {
        claim.seenKeys.add(memo.key) // dedupe later entries of this same batch
        written++
      }
      debugLog(
        "mnemon-auto",
        "remember setup:",
        setupId,
        "session:",
        entry.sessionID,
        result.ok ? "ok" : "fail",
        "cat:",
        memo.cat,
        "imp:",
        memo.imp,
        "chars:",
        memo.content.length,
        result.ok ? "" : result.error,
      )
    } catch (error) {
      // Release the claim back to retryable so one bad entry can never stall it forever.
      markRemembered(root, entry, false)
      debugLog("mnemon-auto", "remember error setup:", setupId, "session:", entry.sessionID, error?.message ?? String(error))
    }
  }
  return written
}

const ACTIVE_SWEEPS = new Set()

function scheduleSweep(root, setupId) {
  if (ACTIVE_SWEEPS.has(root)) return
  ACTIVE_SWEEPS.add(root)
  sweepAndRemember(root, setupId)
    .catch((error) => debugLog("mnemon-auto", "sweep error:", error?.message ?? String(error)))
    .finally(() => ACTIVE_SWEEPS.delete(root))
  // Covers the tail turn: a sweep already running at that moment would have claimed the same entry.
  const tailTimer = setTimeout(() => scheduleSweep(root, setupId), REMEMBER_TAIL_DELAY_MS)
  tailTimer.unref?.()
}

async function consumeSessionEvents(ctx, signal, lastUserPrompt, setupId) {
  for await (const event of ctx.event.subscribe({ signal })) {
    try {
      if (signal.aborted) return
      if (setupId !== SETUP_SEQ) return // a newer setup hot-reloaded this plugin: retire stale consumers
      const data = event?.data ?? {}
      if (event?.type === "session.text.ended") {
        const sessionID = data.sessionID
        const text = typeof data.text === "string" ? data.text : ""
        if (
          typeof sessionID === "string" &&
          sessionID !== "" &&
          text.trim().length >= MIN_RUNTIME_TEXT_CHARS
        ) {
          const cwd = await resolveSessionCwd(ctx, sessionID, ctx.location.directory)
          const root = resolveMemoryRoot(cwd)
          // Pending prompts are consumed inside appendRuntimeMemory, under the writer lock.
          const user = lastUserPrompt.get(sessionID) || ""
          lastUserPrompt.delete(sessionID)
          const ok = appendRuntimeMemory(root, {
            ts: new Date().toISOString(),
            sessionID,
            user: clipText(user),
            assistant: clipText(text),
          })
          debugLog(
            "mnemon-auto",
            "runtime append:",
            ok ? "ok" : "skip",
            "setup:",
            setupId,
            "session:",
            sessionID,
            "userChars:",
            user.length,
          )
          if (ok) scheduleSweep(root, setupId)
        }
        continue
      }
      debugLog(
        "mnemon-auto",
        "event:",
        event?.type ?? "unknown",
        "session:",
        data.sessionID ?? data.sessionId ?? "",
        "keys:",
        Object.keys(data).join(","),
      )
    } catch (error) {
      debugLog("mnemon-auto", "event error:", error?.message ?? String(error))
    }
  }
}

export default {
  id: "mnemon",
  setup: setupV2,
  server: MnemonPlugin,
}
