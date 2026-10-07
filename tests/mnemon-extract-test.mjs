import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  claimRememberable,
  classifyMemory,
  clipText,
  extractEntities,
  extractMemory,
  fenceRatio,
  headlineOf,
  markRemembered,
} from "/tmp/mnemon-test-plugin.mjs"

let fail = 0
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`)
  if (!cond) fail++
}

// --- 抽取门槛 -------------------------------------------------------------
const now = Date.now()
const tsOld = new Date(now - 5 * 60_000).toISOString()
const base = { ts: tsOld, sessionID: "ses_t", user: "帮我看看这个接口的返回结构", assistant: "" }
// A throwaway project root: extractMemory derives the project name for tags from
// the grandparent of this path, so it must be a real <something>/<project>/.mnemon
// shape. Hardcoding a developer's home made this suite unrunnable anywhere else.
const projectRoot = join(mkdtempSync(join(tmpdir(), "mnemon-extract-")), "sample-project")
const root = join(projectRoot, ".mnemon")
mkdirSync(root, { recursive: true })
const pad = "（这里补充一段说明性的正文，用来把篇幅拉长到实质内容的下限之上，同时不引入任何额外的信号词。）"

check("太短 → 丢弃", extractMemory({ ...base, assistant: "决定用缓存" }, root) === null)
check(
  "无实体且不足 60 字 → 丢弃",
  extractMemory({ ...base, assistant: "根因是这段代码没有释放写锁，后续分段全部被挡掉。" }, root) === null,
)
check("无信号词 → 丢弃", extractMemory({ ...base, assistant: "好的。" }, root) === null)
check(
  "无信号词长文 → 丢弃",
  extractMemory({ ...base, assistant: "这个问题的处理方式是先看一下接口返回的结构，然后把结果整理出来给用户。" + pad }, root) === null,
)
const fenced = "先看结论：接口正常。然后是大段日志输出。\n" + "```bash\n" + "line ".repeat(80) + "\n```"
check("代码占比过高 → 丢弃", extractMemory({ ...base, assistant: fenced }, root) === null)

// --- 分类与重要度 ---------------------------------------------------------
const pre = extractMemory({ ...base, user: "记住这个偏好：以后都用 tabs，不要再用 spaces。" }, root)
check("偏好（简短）→ preference/5", pre?.cat === "preference" && pre?.imp === 5, `${pre?.cat}/${pre?.imp}`)
check("偏好内容含用户原话", pre?.content.includes("以后都用 tabs") === true, pre?.content.split("\n")[0])
const dec = extractMemory({ ...base, user: "结论是决定改用 pnpm 管理依赖，全项目统一。" }, root)
check("决定 → decision/5", dec?.cat === "decision" && dec?.imp === 5, `${dec?.cat}/${dec?.imp}`)
const ins = extractMemory({
  ...base,
  assistant: "根因是 appendRuntimeMemory 在释放写锁前就把 pending 文件删掉了，导致后续分段全部被挡。",
}, root)
check("根因 → insight/4", ins?.cat === "insight" && ins?.imp === 4, `${ins?.cat}/${ins?.imp}`)
check(
  "有实体即收（无篇幅填充）",
  extractMemory({ ...base, assistant: "实测这个端点返回 HTTP 200，版本是 0.2.10。" }, root)?.cat === "fact",
)
const fac = extractMemory({ ...base, assistant: "实测这个端点返回 HTTP 200，版本是 0.2.10。" + pad }, root)
check("实测 → fact/4", fac?.cat === "fact" && fac?.imp === 4, `${fac?.cat}/${fac?.imp}`)
check("过短 → 丢弃", extractMemory({ ...base, assistant: "根因是锁没释放。" }, root) === null)
check(
  "多信号取最高",
  classifyMemory("记住这个偏好，另外实测版本是 3")?.cat === "preference",
  classifyMemory("记住这个偏好，另外实测版本是 3")?.cat,
)
check("英文词按边界匹配（不误触发）", classifyMemory("This is an important point about support") === null, JSON.stringify(classifyMemory("This is an important point about support")))
check("边界词仍命中：port", classifyMemory("监听 8080 port 上的 service")?.cat === "fact", classifyMemory("监听 8080 port 上的 service")?.cat)
check("边界词仍命中：always", classifyMemory("I will always use pnpm")?.cat === "preference", classifyMemory("I will always use pnpm")?.cat)
check(
  "assistant 复述决定也能入库",
  extractMemory({ ...base, assistant: "结论是决定改用 pnpm 管理依赖，全项目统一。" }, root)?.cat === "decision",
  extractMemory({ ...base, assistant: "结论是决定改用 pnpm 管理依赖，全项目统一。" }, root)?.cat,
)

// --- 实体抽取 -------------------------------------------------------------
const ent1 = extractEntities("见 `src/a.ts` 与 BalanceDeck 的 SqlDiff 输出")
check("实体：路径+驼峰+反引号", JSON.stringify(ent1) === JSON.stringify(["src/a.ts", "BalanceDeck", "SqlDiff"]), JSON.stringify(ent1))
const ent2 = extractEntities("参考 https://platform.stepfun.com/docs/ 即可")
check("实体：URL 被完整捕获", ent2.some((e) => e.startsWith("https://platform.stepfun.com")), JSON.stringify(ent2))
check("实体：不产生孤立 https", !ent2.includes("https"), JSON.stringify(ent2))
check("实体：中文夹写英文标识", JSON.stringify(extractEntities("用 tabs 而不是 spaces 排版")) === JSON.stringify(["tabs", "spaces"]), JSON.stringify(extractEntities("用 tabs 而不是 spaces 排版")))
check("实体：大写词与版本号", JSON.stringify(extractEntities("HTTP 200 返回，版本 0.2.10")) === JSON.stringify(["HTTP", "0.2.10"]), JSON.stringify(extractEntities("HTTP 200 返回，版本 0.2.10")))
check("实体：无命中为空", extractEntities("今天天气不错").length === 0)

// --- 内容整形 -------------------------------------------------------------
check("标题取首句", headlineOf("根因是锁没释放。\n后面是详细说明。") === "根因是锁没释放", headlineOf("根因是锁没释放。\n后面是详细说明。"))
check("标题保留版本号", headlineOf("实测版本是 0.2.10。后面还有内容。") === "实测版本是 0.2.10", headlineOf("实测版本是 0.2.10。后面还有内容。"))
check("标题保留路径点号", headlineOf("文件在 src/a.ts 里。后面还有内容。") === "文件在 src/a.ts 里", headlineOf("文件在 src/a.ts 里。后面还有内容。"))
check("标题剥列表前缀", headlineOf("1. 先说结论，再说细节。") === "先说结论，再说细节", headlineOf("1. 先说结论，再说细节。"))
check("标题不以版本号开头时不误剥", headlineOf("0.2.10 才是对的版本。") === "0.2.10 才是对的版本", headlineOf("0.2.10 才是对的版本。"))
check("标题超长按预算截断", headlineOf("x".repeat(300) + "。") === "x".repeat(110))
check("clipText 尊重传入预算", clipText("x".repeat(500), 100).length === 100)
check("clipText 默认预算 2000", clipText("x".repeat(5000)).length === 2000)
check("正文要点按预算截断", extractMemory({ ...base, assistant: "实测结果是 " + "y".repeat(2000) }, root)?.content.includes("y".repeat(600)) === true)
check("记忆正文总量有界", (extractMemory({ ...base, assistant: "实测结果是 " + "y".repeat(2000) }, root)?.content.length ?? 0) < 1100)
check("fenceRatio 正常段接近 0", fenceRatio("这是一段正常的中文说明文字。" + "字".repeat(80)) < 0.1)
check("fenceRatio 代码段接近 1", fenceRatio("```bash\n" + "echo x\n".repeat(60) + "```") > 0.9)
check("正文结构完整", fac?.content.split("\n").length === 3 && fac?.content.startsWith("[fact] "), fac?.content.split("\n").join(" | "))
check("用户为空时不输出空的用户行", !extractMemory({ ...base, user: "", assistant: "实测这个端点返回 HTTP 200，版本是 0.2.10。" }, root)?.content.includes("用户："))
check("tags 含项目名", fac?.tags.length === 2 && fac?.tags[1] === basename(projectRoot), JSON.stringify(fac?.tags))
check("key 为 12 位 hex", /^[0-9a-f]{12}$/.test(fac?.key ?? ""), fac?.key)

// --- 认领与标记（跨进程语义） ---------------------------------------------
const tmp = "/tmp/mnemon-claim-test/.mnemon"
rmSync(tmp, { recursive: true, force: true })
mkdirSync(`${tmp}/runtime`, { recursive: true })
const claimOldTs = new Date(now - 9 * 60_000).toISOString()
const claimFreshTs = new Date(now - 5_000).toISOString()
const writeDoc = (entries) => writeFileSync(`${tmp}/runtime/opencode-memories.json`, JSON.stringify({ version: 1, entries }))

writeDoc([
  { ts: claimOldTs, sessionID: "s1", user: "u1", assistant: "a1", remembered: false },
  { ts: claimFreshTs, sessionID: "s2", user: "u2", assistant: "a2", remembered: false },
  { ts: claimOldTs, sessionID: "s3", user: "u3", assistant: "a3", remembered: true, rememberKey: "k3" },
])
const claim = claimRememberable(tmp)
check("只认领过期且未标记的", claim?.picked.length === 1 && claim.picked[0].sessionID === "s1", `picked=${claim?.picked.length}`)
check(
  "已认领写入文件",
  JSON.parse(readFileSync(`${tmp}/runtime/opencode-memories.json`, "utf8")).entries[0].remembered === "claimed",
)
check("重复认领 → null", claimRememberable(tmp) === null)
check(
  "认领时写租约时间",
  typeof JSON.parse(readFileSync(`${tmp}/runtime/opencode-memories.json`, "utf8")).entries[0].claimedAt === "string",
)

// 租约过期 = 认领进程中途死掉，应被接管而不是永久卡死
const staleClaimedAt = new Date(now - 10 * 60_000).toISOString()
writeDoc([{ ts: claimOldTs, sessionID: "s1", user: "u1", assistant: "a1", remembered: "claimed", claimedAt: staleClaimedAt }])
const reclaim = claimRememberable(tmp)
check("过期租约被接管", reclaim?.picked.length === 1 && reclaim.picked[0].sessionID === "s1", `picked=${reclaim?.picked.length}`)
const newClaimedAt = JSON.parse(readFileSync(`${tmp}/runtime/opencode-memories.json`, "utf8")).entries[0].claimedAt
check("接管后刷新租约", Date.now() - Date.parse(newClaimedAt) < 5_000, newClaimedAt)
writeDoc([{ ts: claimOldTs, sessionID: "s1", user: "u1", assistant: "a1", remembered: "claimed", claimedAt: new Date().toISOString() }])
check("新鲜租约不被抢占", claimRememberable(tmp) === null)
check("markRemembered 落 key", markRemembered(tmp, { ts: claimOldTs, sessionID: "s1" }, true, "abc123") === true)
check(
  "rememberKey 已持久化",
  JSON.parse(readFileSync(`${tmp}/runtime/opencode-memories.json`, "utf8")).entries[0].rememberKey === "abc123",
)
// s2 由新鲜变过期后再认领，检查历史 key 是否进 seenKeys
writeDoc([
  { ts: claimOldTs, sessionID: "s1", user: "u1", assistant: "a1", remembered: true, rememberKey: "abc123" },
  { ts: new Date(now - 8 * 60_000).toISOString(), sessionID: "s2", user: "u2", assistant: "a2", remembered: false },
  { ts: claimOldTs, sessionID: "s3", user: "u3", assistant: "a3", remembered: true, rememberKey: "k3" },
])
const seen = claimRememberable(tmp)?.seenKeys ?? new Set()
check("seenKeys 含历史 key", seen.has("k3") === true && seen.has("abc123") === true, [...seen].join(","))
check(
  "s2 被认领",
  JSON.parse(readFileSync(`${tmp}/runtime/opencode-memories.json`, "utf8")).entries[1].remembered === "claimed",
)

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
