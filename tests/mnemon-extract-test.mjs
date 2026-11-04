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
  isParaphrase,
  markRemembered,
  sessionSiblings,
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

// --- 问答复述 vs 正规业务（T2/T3/T4：否定信号 + 用户意图一票否决） --------
check("meta：谈论对话本身 → 复述", isParaphrase({ user: "官方插件和我们的区别", assistant: "好问题。结论是三层区别：读侧闸门、写侧自动化。" }, []) === "meta")
check(
  "question-echo：问句 + 无新实体 → 复述",
  isParaphrase({ user: "为什么这次没有命中？", assistant: "结论是这次没有命中，因为查询太短。" }, []) === "question-echo",
)
check(
  "question-echo：带来新实体则放行（真排障）",
  isParaphrase({ user: "为什么报错？", assistant: "实测返回 HTTP 500，根因是 8080 端口被占用，版本 0.2.10。" }, []) === null,
)
check(
  "receipt：执行回执 → 复述",
  isParaphrase({ user: "把这个提交", assistant: "已提交。远端已推到 f4fc153，标签 v0.2.0，live 插件 hash 一致。" }, []) === "receipt",
)
check(
  "真业务无信号 → 放行",
  isParaphrase({ user: "跑流程发现很多问题", assistant: "结论是 4 个现象里 3 个是同一个根因：opencode.db 的写入。" }, []) === null,
)
check("空轮次 → 放行（无可判）", isParaphrase({ user: "", assistant: "" }, []) === null)
check(
  "commitment：空头承诺 → 复述",
  isParaphrase({ user: "帮我发个版", assistant: "我来处理发布事项，结论是先走版本提交再走远端推送。" }, []) === "commitment",
)
check(
  "commitment：带测量值则放行",
  isParaphrase({ user: "帮我发个版", assistant: "我来把 0.3.2 发了，结论是先打 tag。" }, []) === null,
)
check(
  "override：用户说记住 → 跳过复述门",
  isParaphrase({ user: "记住这个结论，以后都按三层区别讲", assistant: "好问题。结论是三层区别：读侧闸门、写侧自动化。" }, []) === null,
)
// overlap：与同会话更早轮次高度重合 → 总结复述（基线业务最高 0.47，阈值 0.6 留余量）
const rtRoot = join(mkdtempSync(join(tmpdir(), "mnemon-paraphrase-")), "proj", ".mnemon")
mkdirSync(join(rtRoot, "runtime"), { recursive: true })
const prior = "剥开包装，剩下三层本质区别：读侧的闸门、写侧的自动化、项目层的记忆作用域。官方插件只有最薄的一层。"
writeFileSync(
  join(rtRoot, "runtime", "opencode-memories.json"),
  JSON.stringify({
    version: 1,
    entries: [
      { ts: "2026-11-04T00:00:00.000Z", sessionID: "ses_o", user: "区别是什么", assistant: prior },
      { ts: "2026-11-04T00:01:00.000Z", sessionID: "ses_o", user: "继续", assistant: `${prior}读侧是直通，写侧靠自觉。` },
    ],
  }),
)
const cur = { ts: "2026-11-04T00:02:00.000Z", sessionID: "ses_o", user: "继续", assistant: `结论是${prior}读侧是直通。` }
check("高重叠 → overlap", isParaphrase(cur, sessionSiblings(rtRoot, cur)) === "overlap")
check(
  "extractMemory 接入：复述整轮被丢弃",
  extractMemory({ ...base, user: "那官方插件和我们的区别", assistant: "好问题。结论是三层区别：读侧闸门、写侧自动化。" }, root) === null,
)
check(
  "extractMemory 接入：override 照存",
  extractMemory(
    {
      ...base,
      user: "记住：以后都按三层区别讲",
      assistant: "好问题。结论是三层区别：读侧的闸门过滤、写侧的全自动流水线，外加项目层的记忆作用域隔离，三个缺一不可，细节见实现文档。",
    },
    root,
  )?.cat === "preference",
)
check(
  "extractMemory 接入：回执被丢弃",
  extractMemory({ ...base, user: "把这个提交", assistant: "已提交。远端已推到 f4fc153，验证步骤见上。" }, root) === null,
)
check(
  "extractMemory 接入：空头承诺被丢弃",
  extractMemory(
    {
      ...base,
      user: "帮我发个版",
      assistant: "我来处理发布事项。结论是先走版本提交再走远端推送，全流程分三步走，每一步都要先确认再继续推进。",
    },
    root,
  ) === null,
)

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
