import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildLlmPrompt,
  LLM_ENABLE_FLAG,
  LLM_MODEL_CHAIN,
  llmExtractConfig,
  llmExtractMemory,
  llmWorthyEntry,
  hooksDisabled,
  mnemonCommand,
  modelRefFromName,
  parseLlmReply,
  pickModelRef,
  setLlmCatalog,
  setLlmGenerate,
  sweepAndRemember,
  withTimeoutMs,
} from "/tmp/mnemon-test-plugin.mjs"

let fail = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fail++
}
const sh = (args) => execFileSync("mnemon", args, { encoding: "utf8", timeout: 90_000 }).trim()

// --- mnemonCommand：PATH 上是 npm shim 时必须解析到 native 二进制 -------------
// 直接 spawn 那个 JS launcher 的话，timeout 只会杀掉 launcher，native 子进程变孤儿。
const resolvedMnemon = mnemonCommand()
check("解析出非空路径", typeof resolvedMnemon === "string" && resolvedMnemon.length > 0, resolvedMnemon)
check("不指向 npm 的 JS launcher", !resolvedMnemon.endsWith("/bin/mnemon.js"), resolvedMnemon)
check("解析结果确实存在", existsSync(resolvedMnemon), resolvedMnemon)
check("结果被缓存（多次调用不重算）", mnemonCommand() === resolvedMnemon)
check("解析出的二进制能执行", sh(["status"]).length > 0)

// --- hooksDisabled：TRELLIS_HOOKS 总闸（与 BalanceDeck 三个插件同款） ---------
// 文档声称它是总开关，但 mnemon 之前根本没读它——只在 BalanceDeck 的本地插件里生效。
delete process.env.TRELLIS_HOOKS
delete process.env.TRELLIS_DISABLE_HOOKS
check("默认未禁用", hooksDisabled() === false)
check("MNEMON_AUTOMEM=0 不是总闸（只关写侧）", (() => {
  process.env.MNEMON_AUTOMEM = "0"
  const result = hooksDisabled() === false
  delete process.env.MNEMON_AUTOMEM
  return result
})())
process.env.TRELLIS_HOOKS = "0"
check("TRELLIS_HOOKS=0 → 禁用", hooksDisabled() === true)
check("同时设 MNEMON_AUTOMEM=0 仍是禁用", (() => {
  process.env.MNEMON_AUTOMEM = "0"
  const result = hooksDisabled() === true
  delete process.env.MNEMON_AUTOMEM
  return result
})())
delete process.env.TRELLIS_HOOKS
process.env.TRELLIS_DISABLE_HOOKS = "1"
check("TRELLIS_DISABLE_HOOKS=1 → 禁用", hooksDisabled() === true)
delete process.env.TRELLIS_DISABLE_HOOKS
process.env.TRELLIS_HOOKS = "1"
check("TRELLIS_HOOKS=1 → 未禁用", hooksDisabled() === false)
delete process.env.TRELLIS_HOOKS

// --- setup 守卫接线：总闸开启时一个 hook 都不注册 ------------------------------
// env 开关是进程级的：opencode run 是客户端，插件实例全在常驻 server 进程里，
// 所以无法用 headless 探针 A/B 验证，只能直接验 setup 的接线。
const { default: plugin } = await import("/tmp/mnemon-test-plugin.mjs")
const hookCalls = []
const mockCtx = {
  location: { directory: "/tmp/mnemon-guard" },
  shell: { hook: async (...args) => { hookCalls.push(`shell.hook:${args[0]}`) } },
  session: { hook: async (...args) => { hookCalls.push(`session.hook:${args[0]}`) }, get: async () => ({ directory: "/tmp/mnemon-guard" }) },
  event: { subscribe: () => { hookCalls.push("event.subscribe"); return (async function* () {})() } },
  generate: { text: async () => ({ text: "" }) },
  model: { list: async () => ({ data: [] }) },
}
process.env.TRELLIS_HOOKS = "0"
hookCalls.length = 0
await plugin.setup(mockCtx)
check("总闸开启时 setup 不注册任何 hook", hookCalls.length === 0, hookCalls.join(","))
check("总闸开启时未订阅事件总线", !hookCalls.includes("event.subscribe"), hookCalls.join(","))
delete process.env.TRELLIS_HOOKS
hookCalls.length = 0
await plugin.setup(mockCtx)
check("总闸关闭时注册 shell.env + 两个 session hook", hookCalls.includes("shell.hook:create.before") && hookCalls.includes("session.hook:prompt") && hookCalls.includes("session.hook:compaction"), hookCalls.join(","))
check("总闸关闭时订阅事件总线", hookCalls.includes("event.subscribe"))

// 测试用模型目录：生产里由 ctx.model.list() 注入，目录为空时校验被跳过。
const CHAIN0 = LLM_MODEL_CHAIN[0]
const CHAIN0_REF = {
  providerID: CHAIN0.slice(0, CHAIN0.indexOf("/")),
  modelID: CHAIN0.slice(CHAIN0.indexOf("/") + 1),
}
setLlmCatalog(() => [
  { id: "test-model", providerID: "testprov", modelID: "test-model" },
  { id: CHAIN0_REF.modelID, providerID: CHAIN0_REF.providerID, modelID: CHAIN0_REF.modelID },
])

// --- modelRefFromName / pickModelRef：ctx.generate.text 要 { id, modelID, providerID } ---
check(
  "provider/model → id 是裸 modelID（传完整名会被拼成 provider/provider/model）",
  JSON.stringify(modelRefFromName("opencode-go/qwen3.8-flash")) === '{"id":"qwen3.8-flash","providerID":"opencode-go","modelID":"qwen3.8-flash"}',
)
check("无斜杠 → null", modelRefFromName("qwen3.8-flash") === null)
check("空字符串 → null", modelRefFromName("") === null)
check("非字符串 → null", modelRefFromName(undefined) === null)

const CATALOG = [
  { id: "m-a", providerID: "prov", modelID: "m-a" },
  { id: CHAIN0_REF.modelID, providerID: CHAIN0_REF.providerID, modelID: CHAIN0_REF.modelID },
]
const OTHERS_ONLY = [{ id: "m-a", providerID: "prov", modelID: "m-a" }]
check("配置模型在目录里 → 命中", pickModelRef(CATALOG, "prov/m-a")?.modelID === "m-a")
check("配置不在目录里 → 降级到偏好表", pickModelRef(CATALOG, "sensenova/whatever")?.providerID === CHAIN0_REF.providerID)
check("配置为空 → 走偏好表第一项", pickModelRef(CATALOG, "")?.modelID === CHAIN0_REF.modelID)
check("偏好表也不在目录里 → null", pickModelRef(OTHERS_ONLY, "sensenova/whatever") === null)
check("目录为空 → 信任配置不校验", pickModelRef([], "myproj/custom-model")?.providerID === "myproj")
check("目录非数组 → 按空目录处理", pickModelRef(null, "myproj/custom-model")?.modelID === "custom-model")

// --- parseLlmReply：模型输出可能带围栏或前后散文 --------------------------------
check("剥掉代码围栏", parseLlmReply('```json\n{"keep":true,"cat":"fact"}\n```')?.keep === true)
check("剥掉前后散文", parseLlmReply('好的，结果如下：{"keep":false} 希望有帮助。')?.keep === false)
check("非法 JSON → null", parseLlmReply('{"keep":tru}') === null)
check("无 JSON → null", parseLlmReply("这一轮不值得保存。") === null)
check("非字符串 → null", parseLlmReply(undefined) === null)
check("字段原样取出", parseLlmReply('{"keep":true,"imp":"5","cat":"weird"}')?.cat === "weird")

// --- llmWorthyEntry：与规则路径共享的粗筛 --------------------------------------
const worthy = { user: "记一下：以后前端构建产物都放 dist-web 目录。", assistant: "好的，已记录：前端构建输出固定到 dist-web 目录。" }
check("有实质内容 → 值得交给模型", llmWorthyEntry(worthy) === true)
check("太短 → 不值得", llmWorthyEntry({ user: "好", assistant: "好的。" }) === false)
check("纯代码 → 不值得", llmWorthyEntry({ user: "", assistant: "```bash\n" + "line ".repeat(80) + "\n```" }) === false)
check(
  "带防递归标记 → 不值得",
  llmWorthyEntry({ user: "", assistant: "[mnemon-extract] 你是对话记忆的抽取器。" + "内容片段 ".repeat(20) }) === false,
)

// --- buildLlmPrompt -----------------------------------------------------------
const prompt = buildLlmPrompt("用户的问题原文", "助手的回答原文")
check("提示自带防递归标记", prompt.includes("[mnemon-extract]") === true)
check("提示含双方原文", prompt.includes("用户的问题原文") === true && prompt.includes("助手的回答原文") === true)
check("提示给出 JSON 契约", prompt.includes('"keep"') === true && prompt.includes("summary") === true && prompt.includes("entities") === true)

// --- withTimeoutMs ------------------------------------------------------------
check("未超时正常返回", (await withTimeoutMs(Promise.resolve(42), 500, "fast")) === 42)
{
  // The guard timer is unref'd on purpose (a hung model call must not keep OpenCode alive),
  // so the event loop needs something ref'd or this await could never settle.
  const keeper = setInterval(() => {}, 500)
  try {
    const started = Date.now()
    const caught = await withTimeoutMs(new Promise(() => {}), 40, "hung")
      .then(() => null)
      .catch((error) => error)
    check("挂起调用被超时打断", caught instanceof Error, `${caught?.message ?? "no error"} (${Date.now() - started}ms)`)
  } finally {
    clearInterval(keeper)
  }
}

// --- llmExtractMemory 纯路径 --------------------------------------------------
process.env.MNEMON_LLM_EXTRACT = "1"
const ROOT = "/tmp/mnemon-llm-unit/.mnemon"
setLlmGenerate(async () => ({ text: '{"keep":false}' }))
check("keep:false → 不产出", (await llmExtractMemory(worthy, ROOT)) === null)
setLlmGenerate(async () => {
  throw new Error("model unavailable")
})
check("模型异常 → 静默返回 null", (await llmExtractMemory(worthy, ROOT)) === null)
setLlmGenerate(async () => ({ text: '```json\n{"keep":true,"cat":"weird","imp":99,"summary":"以后构建产物都放 dist-web 目录","detail":"用户要求把前端构建输出固定到 dist-web，不要再放 dist。","entities":["dist-web","dist","   "]}\n```' }))
const memo = await llmExtractMemory(worthy, ROOT)
check("产出 memo", memo !== null)
check("非法类别回落 fact", memo?.cat === "fact", memo?.cat)
check("imp 钳到 1-5 且不低于下限", memo?.imp === 5, String(memo?.imp))
check("正文沿用规则路径的模板", memo?.content.startsWith("[fact] ") === true && memo?.content.includes("要点：") === true, memo?.content.split("\n")[0])
check("正文保留实体原文", memo?.content.includes("dist-web") === true)
check("派生 key 为 12 位摘要", typeof memo?.key === "string" && memo.key.length === 12, memo?.key)
check("空白实体被过滤", JSON.stringify(memo?.entities) === '["dist-web","dist"]', JSON.stringify(memo?.entities))
check("标签沿用规则路径", JSON.stringify(memo?.tags) === '["opencode","mnemon-llm-unit"]', JSON.stringify(memo?.tags))

// --- sweepAndRemember 接线（真实 CLI 写临时库） --------------------------------
const base = "/tmp/mnemon-llm-e2e"
const root = `${base}/.mnemon`
rmSync(base, { recursive: true, force: true })
mkdirSync(`${root}/runtime`, { recursive: true })
const runtimeFile = `${root}/runtime/opencode-memories.json`
const oldTs = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
const seed = (entries) => writeFileSync(runtimeFile, JSON.stringify({ version: 1, entries }))
const readDoc = () => JSON.parse(readFileSync(runtimeFile, "utf8"))
const reply = (keep, extra = "") => ({ text: `{"keep":${keep},"cat":"preference","imp":5,"summary":"以后构建产物都放 dist-web 目录","detail":"用户要求把前端构建输出固定到 dist-web，不要再放 dist。","entities":["dist-web"]}${extra}` })

let calls = 0
setLlmGenerate(async () => {
  calls++
  return reply(true)
})
seed([
  { ts: oldTs(5), sessionID: "ses_llm", user: worthy.user, assistant: worthy.assistant },
  { ts: oldTs(4), sessionID: "ses_rule", user: "结论是决定改用 pnpm 管理依赖。", assistant: "结论是决定改用 pnpm 管理依赖，全项目统一。" },
])
const written = await sweepAndRemember(root, "llm")
check("规则丢弃 + LLM 补抽都入库", written === 2, `written=${written}`)
check("规则命中的轮次不消耗 LLM", calls === 1, `calls=${calls}`)
const byId = Object.fromEntries(readDoc().entries.map((entry) => [entry.sessionID, entry]))
check("LLM 条目标记 remembered", byId.ses_llm?.remembered === true, String(byId.ses_llm?.remembered))
check("LLM 条目落 rememberKey", /^[0-9a-f]{12}$/.test(byId.ses_llm?.rememberKey ?? ""), byId.ses_llm?.rememberKey)
check("规则条目标记 remembered", byId.ses_rule?.remembered === true, String(byId.ses_rule?.remembered))

const recall = sh(["--data-dir", root, "--readonly", "recall", "dist-web"])
check("recall 取回 LLM 抽取的记忆", recall.includes("dist-web"), recall.slice(0, 160).replace(/\n/g, " | "))

// 关闭开关：完全不调用 LLM
delete process.env.MNEMON_LLM_EXTRACT
seed([{ ts: oldTs(5), sessionID: "ses_off", user: worthy.user, assistant: worthy.assistant }])
const writtenOff = await sweepAndRemember(root, "llm")
check("关闭时不调用 LLM 也不入库", calls === 1 && writtenOff === 0, `calls=${calls} written=${writtenOff}`)
check("关闭时条目标记但不写库", Object.fromEntries(readDoc().entries.map((entry) => [entry.sessionID, entry])).ses_off?.remembered === true)

// 模型异常：不阻塞、不落 claimed 死条目
process.env.MNEMON_LLM_EXTRACT = "1"
setLlmGenerate(async () => {
  throw new Error("boom")
})
seed([{ ts: oldTs(5), sessionID: "ses_fail", user: "记一下：以后接口超时统一按 8000 毫秒算。", assistant: "已记录：接口超时统一按 8000 毫秒算。" }])
const writtenFail = await sweepAndRemember(root, "llm")
const failed = Object.fromEntries(readDoc().entries.map((entry) => [entry.sessionID, entry])).ses_fail
check("模型异常时不入库", writtenFail === 0, `written=${writtenFail}`)
check("模型异常不留下卡死的 claimed", failed?.remembered === true && failed?.rememberKey === undefined, `${failed?.remembered}/${failed?.rememberKey}`)

// 防递归：生成文本自身不得回流
setLlmGenerate(async () => reply(true))
seed([
  {
    ts: oldTs(5),
    sessionID: "ses_marker",
    user: "",
    assistant: "[mnemon-extract] 你是对话记忆的抽取器。" + "内容片段 ".repeat(20),
  },
])
const writtenMarker = await sweepAndRemember(root, "llm")
check("带标记的文本被丢弃且不调用 LLM", writtenMarker === 0 && calls === 1, `written=${writtenMarker} calls=${calls}`)

// --- 文件开关：按项目生效，touch 即开、删即关，不需要重启进程 ----------------
const flagBase = "/tmp/mnemon-llm-flag"
rmSync(flagBase, { recursive: true, force: true })
mkdirSync(`${flagBase}/.mnemon`, { recursive: true })
mkdirSync(`${flagBase}/empty`, { recursive: true })
const flagDir = `${flagBase}/.mnemon`
const flagFile = join(flagDir, LLM_ENABLE_FLAG)
delete process.env.MNEMON_LLM_EXTRACT
delete process.env.MNEMON_LLM_MODEL

check("无 env 无标记文件 → 关闭", llmExtractConfig(flagDir) === null)

writeFileSync(flagFile, "")
check("空标记文件 → 开启（模型未指定，走偏好表）", (() => {
  const config = llmExtractConfig(flagDir)
  return !!config && config.source === "file" && config.model === ""
})())

writeFileSync(flagFile, "sensenova/sensenova-u1.5-lite\n")
check("标记文件内容作为模型 ID", llmExtractConfig(flagDir)?.model === "sensenova/sensenova-u1.5-lite")

process.env.MNEMON_LLM_MODEL = "stepfun/step-3.7-flash"
check("env 模型优先于标记文件", llmExtractConfig(flagDir)?.model === "stepfun/step-3.7-flash")
delete process.env.MNEMON_LLM_MODEL

process.env.MNEMON_LLM_EXTRACT = "1"
check("env=1 无标记文件也开启", llmExtractConfig(`${flagBase}/empty`)?.source === "env")

process.env.MNEMON_LLM_EXTRACT = "0"
check("env=0 压过标记文件", llmExtractConfig(flagDir) === null)
delete process.env.MNEMON_LLM_EXTRACT

// 标记文件驱动真实 sweep：不设任何 env，LLM 也要被调用并入库
const sweepFlag = join(root, LLM_ENABLE_FLAG)
writeFileSync(sweepFlag, "")
setLlmGenerate(async () => {
  calls++
  return reply(true)
})
seed([{ ts: oldTs(5), sessionID: "ses_flag", user: worthy.user, assistant: worthy.assistant }])
const writtenFlag = await sweepAndRemember(root, "flag")
check("标记文件开启后 LLM 被调用并入库", writtenFlag === 1 && calls === 2, `written=${writtenFlag} calls=${calls}`)

rmSync(sweepFlag, { force: true })
seed([{ ts: oldTs(5), sessionID: "ses_off2", user: worthy.user, assistant: "好的，已记录：前端构建输出固定到 dist-web2 目录。" }])
const writtenOff2 = await sweepAndRemember(root, "flag")
check("删掉标记文件后回落到纯规则", writtenOff2 === 0 && calls === 2, `written=${writtenOff2} calls=${calls}`)

delete process.env.MNEMON_LLM_EXTRACT
setLlmGenerate(null)
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
