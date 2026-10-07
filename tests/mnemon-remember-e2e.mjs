import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { sweepAndRemember } from "/tmp/mnemon-test-plugin.mjs"

let fail = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fail++
}
// MNEMON_BIN lets CI point at a locally installed CLI instead of relying on PATH.
// The default is the bare name so the suite exercises the same PATH resolution a
// user's shell does.
const sh = (args) => execFileSync(process.env.MNEMON_BIN || "mnemon", args, { encoding: "utf8", timeout: 90_000 }).trim()

// The global memory root is derived, not hardcoded: the plugin falls back to
// ~/.mnemon for any cwd without a .mnemon, so these isolation assertions must
// target the HOME of whoever runs the suite.
const globalRoot = `${homedir()}/.mnemon`
const digest = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "absent")

const base = "/tmp/mnemon-e2e"
const root = `${base}/.mnemon`
rmSync(base, { recursive: true, force: true })
mkdirSync(`${root}/runtime`, { recursive: true })

const dshFile = `${globalRoot}/runtime/memories.json`
const dshBefore = { digest: digest(dshFile), mtime: existsSync(dshFile) ? statSync(dshFile).mtimeMs : 0 }

// 全局根的运行时文件可能已经存在：无 .mnemon 的 cwd 会按设计回退到 ~/.mnemon 并创建它。
// 所以这里的不变式是"本次 e2e 没动它"，而不是"它不存在"。
const globalRuntimeFile = `${globalRoot}/runtime/opencode-memories.json`
const globalBefore = { digest: digest(globalRuntimeFile), mtime: existsSync(globalRuntimeFile) ? statSync(globalRuntimeFile).mtimeMs : 0 }

const oldTs = new Date(Date.now() - 5 * 60_000).toISOString()
const dupTs = new Date(Date.now() - 4 * 60_000).toISOString()
const trashTs = new Date(Date.now() - 3 * 60_000).toISOString()
const freshTs = new Date(Date.now() - 5_000).toISOString()
const runtimeFile = `${root}/runtime/opencode-memories.json`
const doc = {
  version: 1,
  entries: [
    { ts: oldTs, sessionID: "ses_a", user: "帮我定一下依赖管理方案", assistant: "结论是决定改用 pnpm 管理依赖，全项目统一。" },
    { ts: dupTs, sessionID: "ses_b", user: "帮我定一下依赖管理方案", assistant: "结论是决定改用 pnpm 管理依赖，全项目统一。" },
    { ts: trashTs, sessionID: "ses_c", user: "继续", assistant: "好的。" },
    { ts: freshTs, sessionID: "ses_d", user: "还没说完", assistant: "继续等你的输入。" },
  ],
}
writeFileSync(runtimeFile, JSON.stringify(doc))

const t0 = Date.now()
const written = await sweepAndRemember(root, "e2e")
const elapsed = Date.now() - t0

check("同批去重后只写 1 条", written === 1, `written=${written} (${elapsed}ms)`)

const after = JSON.parse(readFileSync(runtimeFile, "utf8"))
const byId = Object.fromEntries(after.entries.map((entry) => [entry.sessionID, entry]))
check("有效条目标记 remembered", byId.ses_a.remembered === true)
check("有效条目落 rememberKey", /^[0-9a-f]{12}$/.test(byId.ses_a.rememberKey ?? ""), byId.ses_a.rememberKey)
check("同批重复条目被标记且共享 key", byId.ses_b.remembered === true && byId.ses_b.rememberKey === byId.ses_a.rememberKey, `${byId.ses_b.remembered}/${byId.ses_b.rememberKey}`)
check("低价值条目标记但不写库", byId.ses_c.remembered === true && byId.ses_c.rememberKey === undefined)
check("新鲜条目未被认领", byId.ses_d.remembered === undefined)

const status = sh(["--data-dir", root, "--readonly", "status"])
check("临时库有且仅有一条记忆", /insight/i.test(status) && /\b1\b/.test(status), status.split("\n").slice(0, 12).join(" | "))

const recall = sh(["--data-dir", root, "--readonly", "recall", "pnpm"])
check("recall 能取回写入内容", recall.includes("pnpm"), recall.slice(0, 200).replace(/\n/g, " | "))

const writtenAgain = await sweepAndRemember(root, "e2e")
check("重复 sweep 不再写入", writtenAgain === 0, `written=${writtenAgain}`)

const status2 = sh(["--data-dir", root, "--readonly", "status"])
check("去重后库内仍只有一条", status2 === status || /\b1\b/.test(status2), status2.split("\n").slice(0, 6).join(" | "))

// dsh 全局库隔离。statSync 无条件调用会在文件不存在时抛错，而 CI 上它本来就不存在——
// 不变式是"本次 e2e 没动它"，不存在同样满足。
const mtimeOf = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0)
check("dsh 全局运行时文件未被改动", digest(dshFile) === dshBefore.digest && mtimeOf(dshFile) === dshBefore.mtime)
check("全局 ~/.mnemon 运行时未被改动", digest(globalRuntimeFile) === globalBefore.digest && mtimeOf(globalRuntimeFile) === globalBefore.mtime)
check("全局锁文件未被创建", !existsSync(`${globalRoot}/runtime/.opencode-memories.lock`))

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
