import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LLM_MODEL_CHAIN,
  MARKER,
  MAX_QUERY_CHARS,
  RECALL_BAND,
  RECALL_CACHE,
  RECALL_EXCERPT_CHARS,
  RECALL_MAX,
  RECALL_MIN_QCHARS,
  RECALL_MIN_SCORE,
  RECALL_SECTION_MAX_CHARS,
  STATUS_CACHE,
  STATUS_SECTION_MAX_CHARS,
  STATUS_TTL_MS,
  buildRecallContext,
  buildRuntimeSection,
  cachedRecallContext,
  compressStatus,
  gateQuery,
  gateRecallResults,
  getStatusSection,
  hooksDisabled,
  lastUserMessage,
  llmModelChain,
  prependText,
  renderRecallSection,
} from "/tmp/mnemon-test-plugin.mjs"

let fail = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fail++
}

// --- 合成 fixture（形状对齐 recall --verbose 的条目；不含任何真实记忆内容）----

const insight = (id, content, category = "fact") => ({
  id,
  content,
  category,
  importance: 4,
  tags: ["opencode", "workspace"],
  entities: [],
  source: "agent",
  access_count: 0,
  created_at: "2026-10-11T00:00:00.000Z",
  updated_at: "2026-10-11T00:00:00.000Z",
})

// graph/temporal neighbour with zero lexical signal — the measured padding form.
const paddingItem = (id, score) => ({
  insight: insight(id, `图邻居凑数条目 ${id}，与当前查询没有关系。`),
  score,
  intent: "WHEN",
  via: "temporal",
  signals: { keyword: 0, entity: 0, similarity: 0, graph: 1 },
})

// A real lexical hit: at least one of keyword/entity/similarity is non-zero.
const lexicalItem = (id, score, category = "preference", signals = { keyword: 2, entity: 1, similarity: 0.4, graph: 0 }) => ({
  insight: insight(id, `与查询真实相关的记忆 ${id}：本仓库配置文件一律用 tabs 缩进，不要空格。`, category),
  score,
  intent: "WHY",
  via: "keyword",
  signals,
})

// 重复内容：同一 content 以两条记录命中（同内容多 ID），只应保留最高分那条。
const duplicateItem = (id, score, sharedContent) => ({
  insight: insight(id, sharedContent, "fact"),
  score,
  intent: "WHY",
  via: "keyword",
  signals: { keyword: 2, entity: 1, similarity: 0.4, graph: 0 },
})

// --- 常量与 design.md §3 一致性 --------------------------------------------

check("RECALL_MIN_SCORE=0.25", RECALL_MIN_SCORE === 0.25, String(RECALL_MIN_SCORE))
check("RECALL_BAND=0.15", RECALL_BAND === 0.15, String(RECALL_BAND))
check("RECALL_MAX=4", RECALL_MAX === 4, String(RECALL_MAX))
check("RECALL_MIN_QCHARS=6", RECALL_MIN_QCHARS === 6, String(RECALL_MIN_QCHARS))
check("STATUS_TTL_MS=60_000", STATUS_TTL_MS === 60_000, String(STATUS_TTL_MS))

// --- gateQuery：短查询门槛 --------------------------------------------------

check('gateQuery("删") === false', gateQuery("删") === false)
check('gateQuery("继续") === false', gateQuery("继续") === false)
check('gateQuery("") === false', gateQuery("") === false)
check('gateQuery("   ") === false', gateQuery("   ") === false)
check('gateQuery(非字符串) === false', gateQuery(null) === false && gateQuery(undefined) === false)
check(
  'gateQuery("dsh-mnemon 的召回质量闸门标准") === true',
  gateQuery("dsh-mnemon 的召回质量闸门标准") === true,
)
check(
  'gateQuery("为什么每次给opencode发消息调取mnemon") === true',
  gateQuery("为什么每次给opencode发消息调取mnemon") === true,
)
check("空白不计入门槛字符数", gateQuery("a b c") === false && gateQuery("abcdef") === true)

// --- padding-only → 整段不注入 ---------------------------------------------

const paddingPayload = [
  paddingItem("m1", 0.3),
  paddingItem("m2", 0.3),
  paddingItem("m3", 0.3),
  paddingItem("m4", 0.3),
  paddingItem("m5", 0.3),
]
const gatedPad = gateRecallResults(paddingPayload)
check("padding-only → kept=0", gatedPad.kept.length === 0, `kept=${gatedPad.kept.length}`)
check("padding-only → dropped=5", gatedPad.dropped === 5, `dropped=${gatedPad.dropped}`)
check("padding-only → padding=5", gatedPad.padding === 5, `padding=${gatedPad.padding}`)
check("padding-only → reason=signal", gatedPad.reason === "signal", gatedPad.reason)
check("padding-only → total=5", gatedPad.total === 5, String(gatedPad.total))
check("padding-only → renderRecallSection 返回 null", renderRecallSection(gatedPad) === null)

// --- lexical 命中 → 相对带过滤 + cap=4 --------------------------------------

const mixedPayload = [
  lexicalItem("l1", 0.38),
  paddingItem("p1", 0.37),
  paddingItem("p2", 0.33),
  lexicalItem("l2", 0.31, "insight"),
  lexicalItem("l3", 0.29, "fact"),
  lexicalItem("l4", 0.27),
  lexicalItem("l5", 0.26), // 第 5 个 lexical 命中：cap 生效被截掉
  lexicalItem("l6", 0.22), // < RECALL_MIN_SCORE → score drop
]
const gatedMixed = gateRecallResults(mixedPayload)
check("lexical 命中 → kept=4（cap 生效）", gatedMixed.kept.length === 4, `kept=${gatedMixed.kept.length}`)
check("lexical 命中 → padding 全 drop", gatedMixed.padding === 2, `padding=${gatedMixed.padding}`)
check("lexical 命中 → dropped=4", gatedMixed.dropped === 4, `dropped=${gatedMixed.dropped}`)
check("lexical 命中 → topScore=0.38", gatedMixed.topScore === 0.38, String(gatedMixed.topScore))
check("lexical 命中 → reason=score|signal", gatedMixed.reason === "score|signal", gatedMixed.reason)
check(
  "lexical 命中 → kept 按分降序",
  gatedMixed.kept.map((item) => item.score).join(",") === "0.38,0.31,0.29,0.27",
  gatedMixed.kept.map((item) => item.score).join(","),
)
check(
  "lexical 命中 → render 段头带 N/M",
  renderRecallSection(gatedMixed).startsWith("Relevant recall (4/8 kept, scores are weak evidence):"),
  renderRecallSection(gatedMixed).split("\n")[0],
)

// --- 相对带（高分场景才咬得到；本库天花板 0.38 时带在阈值之下）----------------

const bandPayload = [lexicalItem("h1", 0.9), lexicalItem("h2", 0.8), lexicalItem("h3", 0.5)]
const gatedBand = gateRecallResults(bandPayload)
check("相对带 → 0.5 < 0.9-0.15 被 drop", gatedBand.kept.length === 2 && gatedBand.dropped === 1, `kept=${gatedBand.kept.length} dropped=${gatedBand.dropped}`)
check("相对带 → reason=band", gatedBand.reason === "band", gatedBand.reason)

// --- 内容去重：同 content 多 ID 只保留最高分 ----------------------------------

const sharedContent = "本仓库配置文件一律用 tabs 缩进，不要空格。"
const dupPayload = [
  duplicateItem("d1", 0.38, sharedContent),
  duplicateItem("d2", 0.31, sharedContent),
  lexicalItem("x1", 0.28),
]
const gatedDup = gateRecallResults(dupPayload)
check("内容去重 → kept 只含最高分重复项", gatedDup.kept.length === 2, `kept=${gatedDup.kept.length}`)
check("内容去重 → 高分段保留", gatedDup.kept[0].score === 0.38, `scores=${gatedDup.kept.map(i => i.score).join(",")}`)

// 同源内容但有细微差异（前缀/空白不同，差异在 100 字符键之后）→ 规范化键仍能去重
const longBase = "刚更新了trellis，然发现本项目的插件报错了，请帮我修复。顺便问个问题，看别的项目每次会话中问一句话都会去加载trellis 的session-context，context-state，trellis-workflow。"
const nearDupPayload = [
  duplicateItem("n1", 0.40, `[fact] ${longBase}\n用户：${longBase}\n要点：第一份。`),
  duplicateItem("n2", 0.35, `[fact]${longBase}\n用户：${longBase}\n要点：第二份，细节不同。`),
  lexicalItem("x2", 0.26),
]
const gatedNearDup = gateRecallResults(nearDupPayload)
check("近重复内容 → 规范化去重", gatedNearDup.kept.length === 2, `kept=${gatedNearDup.kept.length}`)
check("近重复内容 → 保留高分", gatedNearDup.kept[0].score === 0.4, `scores=${gatedNearDup.kept.map(i => i.score).join(",")}`)

// --- score 合法性 -----------------------------------------------------------

const invalidPayload = [
  { insight: insight("x1", "无 score 的条目"), signals: { keyword: 1 } },
  { insight: insight("x2", "score 越界"), score: 1.4, signals: { keyword: 1 } },
  { insight: insight("x3", "score 非数字"), score: "abc", signals: { keyword: 1 } },
  { insight: insight("x4", "score 为 null"), score: null, signals: { keyword: 1 } },
  { insight: insight("x5", "score 缺失 signals → 视为 padding"), score: 0.3 },
]
const gatedInvalid = gateRecallResults(invalidPayload)
check("非法 score × 4 → invalid drop", gatedInvalid.reason === "invalid|signal", gatedInvalid.reason)
check("非法 score → kept=0（无 lexical 命中）", gatedInvalid.kept.length === 0, `kept=${gatedInvalid.kept.length}`)
check("payload 为空 / 非数组 → kept=0", gateRecallResults(null).kept.length === 0 && gateRecallResults({}).kept.length === 0)

// opts 覆盖：minScore / band / max 可调（测试面；生产走默认常量）
const tuned = gateRecallResults([lexicalItem("t1", 0.3), lexicalItem("t2", 0.28)], { minScore: 0.29, max: 1 })
check("opts.minScore 覆盖生效", tuned.kept.length === 1 && tuned.kept[0].score === 0.3, `kept=${tuned.kept.length}`)

// --- renderRecallSection 预算 ----------------------------------------------

const longItems = [0.38, 0.35, 0.32, 0.3].map((score, i) => lexicalItem(`long${i}`, score))
for (const item of longItems) {
  item.insight.content = `[preference] 长内容条目：${"配置文件一律用 tabs 缩进，不要空格。".repeat(24)}`
}
const renderedLong = renderRecallSection({ kept: longItems.map((item) => ({
  content: item.insight.content,
  category: item.insight.category,
  score: item.score,
})), total: 12, dropped: 8, padding: 0 })
const renderedLines = renderedLong.split("\n")
check("render ≤900 字符", renderedLong.length <= RECALL_SECTION_MAX_CHARS, `len=${renderedLong.length}`)
check(
  "render 每行摘录 ≤120 字符",
  renderedLines.slice(1).every((line) => {
    const marker = line.indexOf("] ")
    return marker > 0 && line.length - marker - 2 <= RECALL_EXCERPT_CHARS
  }),
  JSON.stringify(renderedLines.map((line) => line.length)),
)
check("render 每行 ≤150 字符（4 条 ≈700 预算）", renderedLines.slice(1).every((line) => line.length <= 150))
check("render 去换行（摘录内无原始换行）", !renderedLong.slice(renderedLong.indexOf("\n") + 1).includes("\n\n"))
check("render kept 为空 → null", renderRecallSection({ kept: [] }) === null)
check("render 入参为 null → null", renderRecallSection(null) === null)

// --- compressStatus ------------------------------------------------------------

const statusJson = JSON.stringify({
  by_category: { fact: 6, insight: 3, preference: 10 },
  db_size_bytes: 368640,
  db_path: "/Users/someone/project/others/.mnemon/data/default/mnemon.db",
  edge_count: 323,
  total_insights: 19,
  oplog_count: 62,
})
const compressed = compressStatus(statusJson)
check("compressStatus ≤200 字符", compressed.length <= STATUS_SECTION_MAX_CHARS, `len=${compressed.length}`)
check("compressStatus 单行", !compressed.includes("\n"))
check(
  "compressStatus 含类目计数",
  compressed.includes("6 facts") && compressed.includes("3 insights") && compressed.includes("10 preferences"),
  compressed,
)
check("compressStatus 含 edges 与库大小", compressed.includes("323 edges") && compressed.includes("360KB"), compressed)
check("compressStatus 含库名（末两段）", compressed.includes("default/mnemon.db"), compressed)
const single = compressStatus(JSON.stringify({ by_category: { fact: 1 }, edge_count: 0 }))
check("单数不加 s / 0 edges 省略", single.includes("1 fact") && !single.includes("1 facts") && !single.includes("0 edges"), single)

// 坏 JSON → 截断兜底，不丢段
const badJson = `SQLITE_BUSY: database is locked ${"x".repeat(400)}`
const fallbackText = compressStatus(badJson)
check("坏 JSON → 原样截断 ≤200 字符", fallbackText.length <= STATUS_SECTION_MAX_CHARS && fallbackText.startsWith("SQLITE_BUSY"), `len=${fallbackText.length}`)
check("空输出 → 空串（段不注入）", compressStatus("") === "" && compressStatus("   ") === "")
check("非对象 JSON → 截断兜底", compressStatus("[1,2,3]").length <= STATUS_SECTION_MAX_CHARS)

// --- status 缓存：TTL 内命中不 spawn -----------------------------------------

STATUS_CACHE.clear()
// 缓存命中路径不调 runMnemon：若它真的 spawn，dataDir 不存在 → 返回 ""，断言即失败。
STATUS_CACHE.set("/nonexistent/mnemon-root", { ts: Date.now(), text: "cached-status-line" })
const hit = getStatusSection("/nonexistent/mnemon-root")
check("status 缓存命中 → 不 spawn", hit.text === "cached-status-line" && hit.source === "cached", JSON.stringify(hit))

STATUS_CACHE.set("/nonexistent/stale-root", { ts: Date.now() - STATUS_TTL_MS - 1, text: "stale-line" })
const expired = getStatusSection("/nonexistent/stale-root")
check("TTL 过期 → 不返回旧值并重新 spawn", expired.text !== "stale-line" && expired.source === "spawn", JSON.stringify(expired))
STATUS_CACHE.clear()

// --- 真实 CLI 输出体积守卫（mnemon 不可用时跳过）------------------------------

const probe = spawnSync("mnemon", ["recall", "mnemon recall gate test", "--limit", "12", "--verbose"], {
  encoding: "utf8",
  timeout: 15_000,
})
if (probe.error || probe.status !== 0) {
  check("真实 CLI --limit 12 --verbose 输出 <200KB（跳过：mnemon 不可用）", true)
} else {
  const bytes = Buffer.byteLength(probe.stdout || "", "utf8")
  check("真实 CLI --limit 12 --verbose 输出 <200KB（maxBuffer 守卫）", bytes < 200 * 1024, `bytes=${bytes}`)
}

// --- 注入不落历史 / 空召回零税 / 同会话运行时去重 / 缓存 / 去耦合 ----------
// （第 1/2/3/5 处改动的回归守卫；buildRecallContext 在 MNEMON_RECALL=0 时不
// spawn recall，只走 status 缓存，断言与真实 CLI 无关）

const savedRecallEnv = process.env.MNEMON_RECALL
process.env.MNEMON_RECALL = "0"
STATUS_CACHE.clear()
RECALL_CACHE.clear()
const emptyCtx = buildRecallContext("这是一条足够长的查询文本用于触发门禁", tmpdir(), "ses-self")
check("空召回 → 不带 USAGE_HINT", !emptyCtx.includes("Use mnemon when"), `chars=${emptyCtx.length}`)
check("空召回 → 不带运行时段", !emptyCtx.includes("Recent runtime turns"), `chars=${emptyCtx.length}`)
check("空召回 → 不带文档段", !emptyCtx.includes("Workspace documents"), `chars=${emptyCtx.length}`)
check(
  "空召回 → 至多状态段（≤300 字符）",
  emptyCtx === "" || (emptyCtx.includes(MARKER) && emptyCtx.length <= 300),
  `chars=${emptyCtx.length}`,
)
if (savedRecallEnv === undefined) delete process.env.MNEMON_RECALL
else process.env.MNEMON_RECALL = savedRecallEnv
STATUS_CACHE.clear()

// 同会话运行时条目默认过滤（跨会话保留）
const rtRoot = mkdtempSync(join(tmpdir(), "mnemon-rt-"))
mkdirSync(join(rtRoot, "runtime"), { recursive: true })
writeFileSync(
  join(rtRoot, "runtime", "opencode-memories.json"),
  JSON.stringify({
    version: 1,
    entries: [
      { ts: "2026-11-04T00:00:00.000Z", sessionID: "ses-self", user: "本轮问题", assistant: "本轮答复SELF_MARK" },
      { ts: "2026-11-04T00:00:01.000Z", sessionID: "ses-other", user: "别轮问题", assistant: "别轮答复OTHER_MARK" },
    ],
  }),
)
const rtSelf = buildRuntimeSection(rtRoot, 2048, "ses-self")
check("同会话条目被过滤", !rtSelf.includes("SELF_MARK") && rtSelf.includes("OTHER_MARK"), rtSelf.slice(0, 80))
const rtAll = buildRuntimeSection(rtRoot, 2048, "ses-nobody")
check("他会话视角保留全部", rtAll.includes("SELF_MARK") && rtAll.includes("OTHER_MARK"))
const rtNoSid = buildRuntimeSection(rtRoot, 2048)
check("无 sessionID 时不过滤（兼容旧调用）", rtNoSid.includes("SELF_MARK"))

// 同条消息的工具续跑命中缓存，不再重算
RECALL_CACHE.clear()
const q = "缓存查询文本足够长"
const c1 = cachedRecallContext("ses-cache", "msg-1", q, tmpdir())
const cacheHit = RECALL_CACHE.get("ses-cache")
check("首轮写入 RECALL_CACHE", cacheHit?.messageID === "msg-1" && cacheHit?.query === q.slice(0, MAX_QUERY_CHARS))
const c2 = cachedRecallContext("ses-cache", "msg-1", q, tmpdir())
check("同消息复用缓存结果", c1 === c2)
check("RECALL_CACHE 有上限", RECALL_CACHE.size <= 1000)
RECALL_CACHE.clear()

// lastUserMessage 双形状：V1 parts / V2 content
const v1 = lastUserMessage({ messages: [{ info: { role: "user", id: "m1", sessionID: "s1" }, parts: [{ type: "text", text: "hello" }] }] })
check("V1 parts 形状", v1?.text === "hello" && v1?.sessionID === "s1" && v1?.messageID === "m1")
const v2 = lastUserMessage({ messages: [{ role: "user", id: "m2", content: [{ type: "text", text: "world" }] }] })
check("V2 content 形状", v2?.text === "world" && v2?.messageID === "m2")
check("非 user 消息跳过", lastUserMessage({ messages: [{ role: "assistant", parts: [{ type: "text", text: "x" }] }] }) === null)
const pe = []
prependText(pe, "   ")
check("空注入不改 parts", pe.length === 0)
prependText(pe, "x")
check("非空注入前插", pe.length === 1 && pe[0].text === "x")

// 总闸去耦合：MNEMON_DISABLE 为主，TRELLIS_* 只作 legacy fallback
const savedDisable = process.env.MNEMON_DISABLE
const savedTrellis = process.env.TRELLIS_HOOKS
delete process.env.MNEMON_DISABLE
delete process.env.TRELLIS_HOOKS
check("默认不禁用", hooksDisabled() === false)
process.env.MNEMON_DISABLE = "1"
check("MNEMON_DISABLE=1 禁用", hooksDisabled() === true)
delete process.env.MNEMON_DISABLE
process.env.TRELLIS_HOOKS = "0"
check("TRELLIS_HOOKS=0 仍兼容禁用", hooksDisabled() === true)
if (savedDisable === undefined) delete process.env.MNEMON_DISABLE
else process.env.MNEMON_DISABLE = savedDisable
if (savedTrellis === undefined) delete process.env.TRELLIS_HOOKS
else process.env.TRELLIS_HOOKS = savedTrellis

// 模型链可覆盖，默认链保持导出兼容
const savedModels = process.env.MNEMON_LLM_MODELS
delete process.env.MNEMON_LLM_MODELS
check("默认链等于导出别名", JSON.stringify(llmModelChain()) === JSON.stringify(LLM_MODEL_CHAIN))
process.env.MNEMON_LLM_MODELS = "foo/bar, baz/qux"
check("MNEMON_LLM_MODELS 整体覆盖", JSON.stringify(llmModelChain()) === JSON.stringify(["foo/bar", "baz/qux"]))
if (savedModels === undefined) delete process.env.MNEMON_LLM_MODELS
else process.env.MNEMON_LLM_MODELS = savedModels

// ---------------------------------------------------------------------------

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
