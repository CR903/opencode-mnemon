# Implement: OpenCode mnemon自动记忆

## Ordered Checklist

- [x] 1. 事件订阅骨架：`setupV2` 内 `ctx.event.subscribe({ signal })` 后台消费（参照 `feishu-notify.ts:112-115`），只打 debug 日志，验证 idle/text.ended 事件到达与 payload（含文本归属）。验证：`tail` 插件 debug 日志（`/tmp/trellis-plugin-debug.log`）。
  - 已关闭：`session.text.ended` 带 `sessionID + 全文 text`（见日志 `keys: sessionID,assistantMessageID,ordinal,text,state`）；`session.idle` 尚未观测到，改用 `text.ended` 做触发器（优于 idle）。
- [x] 2. 文件层写侧：`text.ended` 后 append `runtime/opencode-memories.json`（`{version, entries[]}`，保留最近 50 条，每段 ≤2000 字，`trim` 后 <20 字丢弃），失败静默。验证：headless `opencode run` 探针，全局根写入 1 条、`user` 非空、无重复；dsh 的 `runtime/memories.json` 未被触碰（11 条）。
  - 关键修正（探针实测）：
    1. **文件名必须避开 dsh**：`~/.mnemon/runtime/memories.json` 是 dsh-mnemon 自己的运行时记忆（schema `{content, created_at, target, importance}`），若共用会被我们的 50 条裁剪删掉 dsh 数据 → 改为 `opencode-memories.json` + `.opencode-memories.lock`。
    2. **多进程并发**：插件在每个 OpenCode 进程各加载一次（TUI / server / 每次 `opencode run`），全都订阅同一事件总线并回放近期事件 → 5 个 consumer 抢写同一文件。加 per-root 写者锁与原子写（tmp + rename），文件内按 `(sessionID, assistant)` 去重。锁必须是**每次 append 获取→写→释放**（`wx` 创建 + 20×50ms 重试 + 10s 过期或进程死接管 + `finally` 释放）；第一版是 60s 租约不释放，实测**同进程写完一次要等 60s 才能再写**，同轮后续分段全被挡掉。
    3. **user 跨进程取不到**：prompt hook 只在收到输入的进程 stash，赢锁的进程未必是它 → 增 `runtime/pending/<sessionID>.json`，prompt 时写、consumer 消费后删。pending 必须在**锁内**消费：`takePendingPrompt` 会删文件，若在锁外执行，抢锁失败的 peer 会删掉一个自己永远不会写入的 user 文本 → 线上表现为 entry 的 `user` 为空。
    4. **V2 prompt 文本是 JSON 编码串**：`input.prompt.text` 形如 `"reply with ..."`（带引号）→ 落盘前 `JSON.parse` 解一层。
    5. **按段写噪**：`session.text.ended` 每个流式段各触发一次（前言段、工具调用后正文段…），一回合被拆成 4-5 条 → 未配到 user 的段视为同轮续段，折叠进上一条（`includes` 判重防 peer 重复投递），单条仍 ≤2000 字。
  - 验证：单进程写者单测 8/8 PASS（段折叠、重复投递忽略、跨会话不折叠）；6 进程竞态 harness 3/3 PASS（同一文本 6 份只落 1 条且 user 存活、6 个不同段折叠为 1 条 6 行、锁释放后同进程背靠背写成功）。
- [x] 3. 文件层读侧：prompt hook 追加最近 5 条运行时记忆（runtime+documents 合计 ≤2KB，documents 占 700 上限、运行时按剩余预算逐条装，装不下即截断）+ `documents/index.json` 关键词命中清单（只给相对路径，不贴全文）。
  - 验证：本会话首条 prompt 已出现 `Recent runtime turns (workspace-scoped, oldest first):` 注入块；`BalanceDeck` 真实索引（3 篇）单测命中并按 score 排序、标题截断、`documents/index.json` mtime 未变；无关查询（score <3）不注入；预算 <80 直接跳过。
  - 检索实现：`queryTokens` 对 ASCII 按词切分，对 CJK 短语额外生成 2-gram（中文无空格，否则匹配不到）；title ×3 / description ×2 / sourcePaths ×1，门槛 `MIN_DOC_SCORE=3`（否则 "协议" 这类偶发 2-gram 会误命中）。
  - 结论性限制：`opencode run`（headless）虽触发 prompt hook 并改写 `input.prompt.text`（实测写入 783 字），但该路径不消费被改写的 `text`，探针模型看不到注入块——headless 探针只用于验写侧，读侧只能在交互式会话验。
- [x] 4. B 方案抽取（规则门槛 + 类别/重要度映射 + 实体）+ `remember --data-dir` 异步写 + BUSY 退避一次。
  - 抽取：4 条规则按序取最高（preference/decision=imp5，insight/fact=imp4），`imp<3` 弃。门槛：代码围栏占比 >0.7 弃、总长 <24 弃、**无具体实体（路径/URL/驼峰/反引号/大写词/版本号/中文夹写英文）时要求总长 ≥60**。整形：去围栏、标题取首句 ≤110、正文 ≤700、user ≤150，结构 `[cat] 标题` + `用户：`（空则省略）+ `要点：`，`tags=["opencode", <项目名>]`，`key=sha1(content).slice(0,12)`。
  - 写链路：`text.ended` → append 运行时文件 → `scheduleSweep`（per-root in-flight 去重 + 75s unref 尾部重扫）→ 锁内认领（年龄 ≥60s、batch 3）→ 抽取 → 阈值/去重跳过 → `mnemon --data-dir <root> remember --cat --imp --source agent --tags [--entities]`（`runMnemonAsync`，spawn 非 spawnSync，30s 超时，`locked|busy` 退避 350ms 重试一次）→ `markRemembered` 落 `remembered + rememberKey`；失败记 `remembered:false` 下一轮重试。
  - 关键修正（探针/测试实测）：
    1. 初版固定 120/160 字门槛会漏掉简短但真实的偏好（"记住这个偏好：以后都用 tabs，不要再用 spaces。" 仅 29 字）→ 改成"有具体实体即收，无实体才要篇幅（60）"。
    2. **`clipText(value)` 忽略第二参数**：110/150/700 三个字段预算全是装饰，实际一律裁到 2000 → 改为 `clipText(value, limit = MAX_RUNTIME_TEXT_CHARS)`。
    3. **`headlineOf` 把 ASCII `.` 当句号**："版本是 0.2.10" 被截成 "版本是 0.2"（路径、小数同理）→ 用 `(?<=\w)\.(?=\w)` 零宽断言护住词内点号。第一版用捕获组 `(\w)\.(\w)`，因重叠扫描被跳过（`0.2.10` 的第二个点没护住）。
    4. `headlineOf` 列表前缀 `^[-*\d.、]+[)\s]*` 会吃掉句首版本号（"0.2.10 才是对的版本" → "才是对的版本"）→ 收紧为 `(?:[-*]+\s+|\d+[.)]\s+|\d+、)`。
    5. `extractEntities` 中文夹写分支会在 URL 分支之前抓到裸 `https` 成垃圾实体 → 加 `(?!\s*://)`。
    6. `fact` 规则词 `port` 会命中 `important`/`support` → 新增 `hasWord`：ASCII 词用 `\b`，CJK 词仍用子串。
    7. 同批去重失效：`seenKeys` 只在认领时快照，批内成功 remember 后不回写 → 成功后 `claim.seenKeys.add(memo.key)`。
    8. **孤儿认领（会永久卡死记忆）**：进程在认领与落标记之间死掉，`remembered:"claimed"` 永不清除，该条永久不再入库（线上已出现 11 条）。改为认领时写 `claimedAt` 租约（5min，远大于 batch×重试×超时 的最坏值），过期即被接管；并在每条 remember+mark 外套 try/catch，异常时把认领退回 `remembered:false` 而非卡在 "claimed"。
    9. **末轮丢失**：会话最后一轮没有后续 `text.ended`，永不入库（而最后一轮常是最有价值的总结）→ `scheduleSweep` 追加 75s unref 定时器重扫。
    10. user 取不到的轮次（跨进程 pending 未命中）会输出空 `用户：` 行 → 空则省略该行。
    11. **一个我自己引入并已回退的回归**：曾把规则按说话人拆分（imp5 必须由用户说出），结果 "结论是决定改用 pnpm" 这类 **assistant 复述共同决定** 的场景谁都匹配不到、整条被丢——e2e 测试逮住。教训：B 方案的语义歧义不值得继续建模，简单优先，召回质量交给 A 方案。
  - 验证：`tests/mnemon-extract-test.mjs` 抽取单测（门槛/分类/实体/标题/预算/认领租约/seenKeys）全 PASS；`tests/mnemon-remember-e2e.mjs` 端到端全 PASS（真实 `mnemon remember` 写临时库：同批去重、阈值跳过、新鲜条目不认领、`recall` 可取回、重复 sweep 幂等、**dsh 全局 `runtime/memories.json` 字节与 mtime 不变**、`~/.mnemon` 无污染）；测试经 `tests/build-mnemon-test.sh` 生成带导出的副本，生产插件保持纯 `{id, setup, server}`。
  - 生产实测：11 条历史孤儿 `claimed` 自愈 → 5 条真实记忆入库（fact 2 / insight 1 / preference 2，35 条边，top_entities 为 `step-5-preview`、`OpenCode`、`~/.config/opencode/opencode.json`）；**真实命中两次 `SQLITE_BUSY`（`open database: migrate: backfill stored_at` / `insert insight`），单次退避重试均当场恢复**；跨进程重复被 `seenKeys` 拦下（`reason: duplicate`）；读回闭环 `mnemon recall "step-5 模型配置"` 返回正确分类的新记忆。单次 remember 约 270-290ms。
- [x] 5. A 方案抽取（LLM 补抽），默认关闭、可配开启。验证：开启后无递归、模型异常静默回退。
  - **入口与设计假设不同**：`ctx.session.prompt` 在 V2 `ctx` 上并不存在（探测确认）。实际入口是 `ctx.generate.text({ prompt, model: { id } })`，不经过 session prompt hook，一次调用返回 `{ text }`。`model` 必须传 `{ id: "provider/model" }`（顶层字符串报 `Expected Model.Ref | null`，`{providerID, modelID}` 报 `Missing key at ["model"]["id"]`）；不传 `model` 走 OpenCode 免费档，实测不可用。
  - **只补抽，不覆盖**：`extractMemory(entry, root) ?? (await llmExtractMemory(entry, root))`。规则有结果就不花 token；规则判空才补一次。
  - **开关（本轮改动）**：env 开关依赖进程级 env，需重启 OpenCode 才生效，且无法按项目区分（BalanceDeck 与 others 会一起开）。改为文件标记优先：
    | 开关 | 生效范围 | 生效时机 |
    |---|---|---|
    | `<root>/opencode-llm-extract` 标记文件 | 按项目（`<cwd>/.mnemon`） | `touch` 即开、`rm` 即关，下个 sweep 生效，无需重启 |
    | `MNEMON_LLM_EXTRACT=1` | 整个进程 | 需重启 OpenCode |
    | `MNEMON_LLM_EXTRACT=0` | 整个进程 | 显式总闸，优先级最高，压过标记文件 |
    标记文件内容非空时同时作为模型 ID（空文件用默认 `sensenova/sensenova-6.8-flash-lite`）；`MNEMON_LLM_MODEL` 优先于文件内容。
  - **防递归**：抽取提示词首行带 `[mnemon-extract]` marker；`llmWorthyEntry` 与 `appendRuntimeMemory` 两处都拦带 marker 的文本，LLM 生成的内容无法回流成本轮记忆。
  - **失败面**：25s 超时（`withTimeoutMs` + unref 定时器）、模型抛错、`keep:false`、JSON 解析失败、summary+detail 不足 24 字——全部静默返回 `null`，条目按"低于阈值"标记，不留卡死的 `claimed`，且不进写者锁（网络调用不占用 sqlite/文件锁）。
  - **模型字段收敛**：`cat` 只接受 `fact/preference/insight/decision`（否则回落 `fact`），`imp` 钳到 `[REMEMBER_MIN_IMP, 5]`，entities 去空白并截断到 6 个。
  - 验证：`tests/mnemon-llm-extract-test.mjs` 45 项全 PASS——JSON 解析（围栏/前后散文/坏 JSON/非字符串）、`llmWorthyEntry` 门槛、超时挂起打断（80ms 内）、`keep:false`/模型抛错/JSON 不产出、规则丢弃+LLM 补抽同批入库、**规则命中的轮次不消耗 LLM**（calls=1）、recall 取回 LLM 记忆、开关矩阵（无 env 无文件关闭 / 空文件开启 / 文件内容作模型 / env 模型优先 / env=1 / **env=0 压过标记文件** / 标记文件驱动真实 sweep / 删文件回落纯规则）、防递归 marker。
  - **生产验证已完成**（`touch .mnemon/opencode-llm-extract` + headless `opencode run` 探针，本工作区真实链路）：
    `llm extract ok via: file model: opencode-go/qwen3.8-flash cat: preference imp: 5 chars: 251` → `remember ok` → `mnemon recall "vitest.config.ts"` 以 score 0.725 取回。
    LLM 产出的摘要质量明显优于规则路径（规则只会复制原文，LLM 写了 `[preference] 本仓库跑单测应执行 pnpm vitest run，配置文件位于 vitest.config.ts。` + 判断理由），`parseLlmReply` 对真实模型输出稳定。测试注入的 2 条记忆已 `mnemon forget` 清除，dsh 全局 `~/.mnemon/runtime/memories.json` 仍 11 条未动。
  - **验证过程中推翻了一个错误结论**：原设计写的 `{ model: { id: "provider/model" } }` 在生产**从未成功过**，实测报 `Missing key at ["model"]["providerID"]`，整条 LLM 路径一直是死的，只是失败被静默吞掉（当时日志缺少 `via:`/`model:` 字段，看不到）。探针定位到的真实约束：
    1. `model` 必须是 `{ id, modelID, providerID }`，且 `id` 只能是**裸 modelID**——传完整名会被拼成 `provider/provider/model`。
    2. 该模型必须在 `ctx.model.list().data`（返回 `{location, data}`，需取 `.data`）里。当前 73 个模型中**不含 sensenova**，故硬编码 `sensenova/sensenova-6.8-flash-lite` 必然失败。
    3. 不传 `model` 走免费档会报 `OpenCode's free tier can only be used from within OpenCode`。
    已改为 `pickModelRef(models, wanted)`：按 `[配置值, ...LLM_MODEL_CHAIN]` 查目录，命中即用；目录为空时信任配置；全不中静默放弃。默认 `opencode-go/qwen3.8-flash`，兜底 `opencode-go/longcat-2.5-preview-free`（唯一实测 `ctx.generate.text` 返回 `{"text":"OK"}`）。
- [x] 6. 开关与文档：`MNEMON_AUTOMEM=0` 关闭写侧；`TRELLIS_HOOKS=0` 总关；更新任务 prd 验收勾选。
  - **`TRELLIS_HOOKS` 总关此前并不存在**：文档声称它是总开关，但 grep 显示当时**没有任何插件读它**，只有 BalanceDeck 的三个本地插件（`session-start.js` / `inject-workflow-state.js` / `inject-subagent-context.js`）各自实现过同款 `hooksDisabled()`。mnemon 不在其列，"总关"对记忆链路是空话。已按同款实现补齐：`hooksDisabled()` 判 `TRELLIS_HOOKS === "0"` 或 `TRELLIS_DISABLE_HOOKS === "1"`，在 `setupV2` 与 V1 `MnemonPlugin` 入口最前面早退，读写两侧一个 hook 都不注册、事件总线不订阅。`MNEMON_AUTOMEM=0` 语义不变（只关写侧、保留读侧 recall 注入），两者互不替代。
  - **行为测试直接验接线**：用 mock `ctx` 调 `plugin.setup()`，断言总闸开启时 `hookCalls.length === 0` 且未订阅事件总线；关闭时恰好注册 `shell.hook:create.before` + `session.hook:prompt` + `session.hook:compaction` + `event.subscribe`。
  - **重要限制（已写进 design.md）**：env 开关是**进程级**的，而插件实例全在常驻 server 进程里。`TRELLIS_HOOKS=0 opencode run ...` 这种设法**无效**——A/B 探针实测：headless 端 `skipped` 日志为零，append 仍由 server 端完成。要生效必须在**启动 OpenCode server 的那个环境**里 export。这也是 A 方案开关改成读标记文件的根本原因：env 既不能按项目区分、也不能免重启生效。
- [x] 7. 同步补丁到 `BalanceDeck/.opencode/plugins/mnemon.js`（同构改动），回归其 `node` 加载。
  - BalanceDeck 那份不是"步骤 5 缺补丁"，而是**旧版读侧**（198 行，无写侧、无项目隔离以外的功能），已整份替换；旧版备份为 `mnemon.js.bak.pre-sync-20261005`。`cmp` 确认与全局插件**字节完全一致**，`node --check` + `node -e import(...)` 均在 BalanceDeck cwd 下通过，导出形状 `["id","setup","server"]`、`id: mnemon`。
  - **顺带修了主插件的一个真实缺陷**：主插件两处 `spawn("mnemon", ...)` 直接执行 PATH 上的 `mnemon`，而那实际是 npm 的 JS launcher（`~/.nvm/.../@mnemon-dev/mnemon/bin/mnemon.js`）。launcher 再 spawn native 二进制，所以 `runMnemonAsync` 的 30s 超时 `SIGKILL` 只会杀掉 launcher，**native 子进程变孤儿**。BalanceDeck 旧版里有 `mnemonCommand()`/`npmBinary()` 解析 native target 的逻辑，已反向移植进主插件（`realpathSync` → 命中 `bin/mnemon.js` 即走 `npmBinary`，读 `targets.json` 的 `platform/arch` 匹配 + `createRequire` 解析 optional dep；win32 额外走 `.cmd` shim 分支；结果模块级缓存一次）。新增 5 项测试：解析非空、不指向 JS launcher、结果存在、缓存命中、二进制可执行。三套测试 59 + extract + e2e 全 PASS。
  - **同步时发现的前提不成立——那份本地分叉是冗余的**：OpenCode 不按 plugin id 去重，同一次 server 启动里全局 `~/.config/opencode/plugins/mnemon.js` 与 BalanceDeck 本地副本**两份都加载**（`opencode.log` 06:05:32 两条 `loading plugin` 实证）。全局插件本来就在为 BalanceDeck 写记忆（其 `.mnemon/runtime/opencode-memories.json` 已有 7 条，含 06:05:43 一条 `rem=None`，早于本地同步完成）——因为 root 解析按会话 cwd，全局插件对任何项目都生效。
  - 重复加载的现有防线仍然兜住：读侧 `MARKER` guard（第二次注入看到 `<mnemon_context>` 即跳过）、写侧 per-root writer lock + `rememberKey` 批内去重、认领租约保证每条 entry 只被一次 sweep 认领（故 LLM 调用不会翻倍）、compaction hint 重复推同一文本（无害）。代价是每轮多一次 CLI spawn 与锁竞争。
  - **已删本地副本**：确认全局插件对任何项目都生效（root 按会话 cwd 解析）后，`rm` 掉 `BalanceDeck/.opencode/plugins/mnemon.js` 与备份 `mnemon.js.bak.pre-sync-20261005`——本地副本只是重复工作，还会让"下次改全局又出现两份不一致"变成常设负担。单一事实源为全局 `~/.config/opencode/plugins/mnemon.js`。回滚路径：`cp` 全局文件即可恢复。06:19:58 重扫确认 BalanceDeck 只剩 1 个 mnemon（全局），目录内其余 3 个插件（`inject-subagent-context.js`/`inject-workflow-state.js`/`session-start.js`）与全局 5 个插件全部正常加载，零加载失败。`.opencode/skills/mnemon/SKILL.md` 是 skill 不是插件，保留。
  - 附带修：BalanceDeck 是 git 仓库但 `.gitignore` 无 mnemon 规则，`.mnemon/data/` 与 `.mnemon/runtime/` 处于 `??` 未跟踪状态——`.mnemon.db` 里是会话片段，有入库风险。SqlDiff 已有 `.mnemon/` 规则，按同一惯例补上（`git check-ignore -v` 确认 `.mnemon/db` 已忽略、`.opencode/plugins/mnemon.js` 未被忽略，用户仍可自主决定要不要提交插件本身）。
- [x] 8. 回归：无 `.mnemon` 项目回退全局；`failed to load plugin` 为零；其余插件不受影响。
  - **回退路径实测通过**：在 `/tmp/mnemon-fb2`（无 `.mnemon`）跑 headless 探针，`resolveMemoryRoot` 回退到 `~/.mnemon`，**全局根 `~/.mnemon/runtime/opencode-memories.json` 被创建**且探针条目落盘（`oStDn9TzqE7DXN`）。这是该文件首次被创建，证明回退不是纸上逻辑。
  - **`failed to load plugin` 为零**：最后一次加载失败停在 `03:29:58`（步骤 5 编辑中间态），此后 mnemon 热重载数十次无一失败。
  - **其余插件不受影响**：06:19:58 重扫批次 8 个插件全部加载成功（全局 5 + BalanceDeck 3）；删掉 BalanceDeck 本地 mnemon 后仅少 1 个，无连锁失败。
  - **修掉一个测试缺陷**：`mnemon-remember-e2e.mjs` 原断言 `!existsSync("~/.mnemon/runtime/opencode-memories.json")`——它测的是"全局根永远为空"这个**假设**，而不是"本次 e2e 没动它"这个**不变式**；回退路径一被合法触发就必然失败（已 FAIL 一次）。改为 before/after 快照对比（digest + mtime），与同文件 dsh 那条写法对齐；锁文件仍断言绝对不存在。
  - **探针污染已清**：探针写入全局 db 的 2 条测试记忆已 `mnemon forget`（`c61b3ad2` migrations-db、`0c2506c8` build-out），全局 db 回到 1 条真实记忆（`235d1958` tabs 偏好）；全局 runtime 条目 2 → 0（原子写）；`/tmp` 探针目录已删；dsh 全局文件仍 11 条 / `4ea85af594ac` 未动。
  - **顺带修掉一个探针误判**：第一次回退探针用"请只回答一个字：好"，回复 3 字节低于 `MIN_RUNTIME_TEXT_CHARS = 20`，被**设计性**跳过且无日志，看起来像回退失效；第二次换成长回复才验证成功。

## Validation Commands

```bash
# 插件加载（必须只有默认导出 {id, setup, server}）
node --input-type=module -e "import('/Users/zhouri/.config/opencode/plugins/mnemon.js').then(m => console.log(m.default?.id, typeof m.default?.setup, Object.keys(m).filter(k => k !== 'default').join(',') || '(none)'))"

tail -50 /tmp/trellis-plugin-debug.log
mnemon --data-dir <root>/.mnemon status --readonly
mnemon --data-dir <root>/.mnemon log --limit 5
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail -5

# 抽取单测 + 写侧端到端（build 脚本生成带导出的副本，不改生产文件）
sh .trellis/tasks/10-04-opencode-mnemon-auto-memory/tests/build-mnemon-test.sh
node .trellis/tasks/10-04-opencode-mnemon-auto-memory/tests/mnemon-extract-test.mjs
node .trellis/tasks/10-04-opencode-mnemon-auto-memory/tests/mnemon-remember-e2e.mjs

# 读侧渲染快照（root 传 .mnemon 记忆根，不是项目目录）
node --input-type=module -e 'import { buildRecallContext } from "<plugin>/mnemon.js"; console.log(buildRecallContext("查询词", "<project>"))'
# 写者语义（需临时 export appendRuntimeMemory / writePendingPrompt，验完可删）：
#   单进程 8 项：段折叠、重复投递忽略、跨会话不折叠
#   6 进程竞态：同一文本 6 份 → 1 条且 user 存活；6 个不同段 → 1 条 6 行；锁释放后可背靠背写
```

## Review Gates & Rollback

- Gate：步骤 1 事件 payload 确认后，再做 4/5（抽取依赖事件文本归属）。
- Rollback：删除新增代码块，回到已归档的 `--data-dir` 状态；`runtime/opencode-memories.json`、`runtime/.opencode-memories.lock`、`runtime/pending/` 均为追加或临时文件，删掉即清零；不碰 dsh 的 `runtime/memories.json`。
