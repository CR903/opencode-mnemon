# 技术设计：recall 质量闸门 + token 预算

改动边界：`~/project/opencode-mnemon-plugin/mnemon.js` 的**读侧**（`buildRecallContext` 及其调用），写侧（sweep / remember / LLM extract）、hook 注册面、`documents/` 与 `runtime/` 的所有权一律不动。

## 1. 分层数据流（重构后）

```
ctx.session.hook("prompt")            mnemon.js:466
  └─ buildRecallContext(query, cwd)   mnemon.js:337   ← 唯一入口，签名不变
       ├─ gateQuery(query)            纯函数 · 短查询直接跳过 recall 段
       ├─ getStatusSection(root)      spawn + 60s 进程级缓存 → 单行 ≤200c
       ├─ runRecall(query)            spawn `recall --limit 12 --verbose`，空/坏输出重试 1 次
       │    └─ gateRecallResults(payload)   纯函数 · 分数带 + 信号过滤 → {kept, dropped}
       │         └─ renderRecallSection()   纯函数 · 紧凑行 ≤900c，kept=0 → 返回 null
       ├─ buildDocsSection()          不动（已有 MIN_DOC_SCORE=3 阈值）
       ├─ buildRuntimeSection()       不动（≤2048c，按剩余预算裁剪）
       └─ USAGE_HINT                  扩写：深度检索改为按需自取
```

纯函数（`gateQuery` / `gateRecallResults` / `renderRecallSection` / `compressStatus`）是本任务的单测面，经 `tests/build-mnemon-test.sh` 导出；生产文件仍保持纯 `{ id, setup, server }` 形状。

## 2. 检索调用形式：为什么用 `--verbose` 全量而不是 `--brief`

| 选项 | 结果 | 结论 |
|---|---|---|
| `--brief` | 1397c（vs 全量 4616c），**但无 `signals`** | 拿不到判据 |
| `--brief --verbose` | 实测输出**为空**（不可用组合） | 排除 |
| `--basic` | 中文整句 **0 命中**（整句当一个 LIKE 模式） | 排除 |
| `--verbose`（全量） | 有 `score` + `signals.keyword/entity/similarity/graph` | **采用** |

**token 成本为 0**：全量 stdout（实测 **30 038 字符**，limit 12 + verbose，含 entities 与完整 content；延迟实测 0.22–0.29s，status 0.16s）只进 `spawnSync → JSON.parse`，**永远不进模型上下文**；付的是 CPU。这正是"降 token"的关键一手：把贵的东西留在解析层，只把便宜的结论交给模型。

风险控制：`spawnSync` 默认 `maxBuffer` 1MB，实测 30KB 远在安全区；单测断言输出 <200KB，超限即视为该路径不可用 → 降级为 `--brief` + 仅分数过滤（无信号闸门），日志记 `fallback=brief`。

## 3. 闸门规则（对标 dsh `strict-v1`，按本库分数分布调参）

dsh 的 `STRICT_RECALL_QUALITY_POLICY`（`dsh-mnemon-source-memory-spaces/lib/index.js:1084-1150`）：候选扩 3 倍 → `<lowScoreThreshold` 丢 → medium ≤4 → unknown ≤2。直接照抄**无效**，因为本库分数全部挤在 0.25–0.38（实测），绝对阈值 0.25 几乎不筛任何东西。所以做成三层组合：

```
RECALL_LIMIT        = 12     // 过采样，对标 candidateMultiplier=3
RECALL_MIN_SCORE    = 0.25   // 对标 dsh lowScoreThreshold
RECALL_BAND         = 0.15   // 相对带：score < topScore - 0.15 → drop（挡尾巴）
RECALL_MAX          = 4      // 对标 dsh maxMediumResults=4
RECALL_MIN_QCHARS   = 6      // 非空字符数门槛
STATUS_TTL_MS       = 60_000
```

过滤顺序（`gateRecallResults`）：

1. `score` 缺失 / 非有限数 / >1 → drop
2. `score < RECALL_MIN_SCORE` → drop
3. `score < topScore - RECALL_BAND` → drop（相对带，处理分数天花板只有 0.38 的现实）
4. **信号判定**：`keyword + entity + similarity === 0` 的条目记为 *padding*（本库实测的"图邻居/最近凑数"，`删` 这类查询 5 条全是 padding）
   - 存在至少 1 条带 lexical 信号的候选 → padding 全 drop，剩下的按分排序取前 `RECALL_MAX`
   - **全部是 padding**（0 条带信号）→ 返回空，整段不注入，改注入一行按需提示（见 §5）

这一步是本库唯一能区分"命中"与"凑数"的判据：分数区分不了（0.30 的凑数项和 0.31 的命中项同分），信号能。

## 4. 渲染与预算

段头显式告知被过滤，模型据此可以不信任：

```
Relevant recall (2/12 kept, scores are weak evidence):
— [0.38·preference] 本仓库写配置文件一律用 tabs，不用空格。以后碰到配置文件…
— [0.31·insight] Trellis SessionStart 上下文已加载 ✓ …
```

每行 = `— [score·category] 摘录≤120c`（`insight.content` 压掉换行），约 150–180 字符 → 4 条 ≈ 700c，段头 60c，**≤900c**。

| 段 | 现状 | 目标 | 手段 |
|---|---|---|---|
| Status | 1476c | **≤200c** | 解析 JSON 压成单行 + 60s 缓存 |
| Relevant recall | 4616c | **≤900c** | 过采样→闸门→紧凑行；空则整段消失 |
| documents | ≤700c | 不变 | 已有阈值 |
| runtime | ≤2048c | 不变 | 已有界，按剩余预算裁剪 |
| hint | ≈200c | ≈300c | 扩写一句按需检索指引 |
| **合计** | **≈9000c** | **≤3000c** | 降幅 ≥66% |

`compressStatus`：`mnemon status` 输出 JSON（已验证），压成
`17 insights · 19 facts · 9 decisions · 8 preferences · 299 edges · 344KB · default/mnemon.db`；
JSON 解析失败 → 退回原样截断到 200c（兜底，不丢段）。缓存键 = memory root（不同项目不同库），值 = `{ts, text}`。

## 5. 失败与降级路径

| 情况 | 行为 |
|---|---|
| 查询非空字符 < 6 | 不 spawn recall，注入 runtime+docs+hint；段位置留一行 `(short message — recall skipped)` |
| recall 空输出 / JSON 解析失败（观测到过 `SQLITE_BUSY: database is locked`） | 等 150ms 重试 1 次 → 仍失败：**跳过该段**，日志 `recall gate: skipped reason=empty\|parse` |
| 闸门后 0 条 | 整段不注入，替换一行 `(no confident match — run mnemon recall "<query>" --intent WHY\|WHEN\|ENTITY yourself)` |
| `MNEMON_RECALL=0` | 跳过 recall 段（进程级，A/B 对照用；per-project 才需要 flag file，见 spec 决策） |
| `TRELLIS_HOOKS=0` / `MNEMON_AUTOMEM=0` | 语义不变（前者全关、后者只关写侧） |

**注入本身永不失败**：`buildRecallContext` 内任何一步抛错都被 `runMnemon` 的 try/catch 与新函数的守卫吸收，最坏退化为"只有 runtime + docs + hint"。

## 6. 可观测性（R7）

`debugLog("mnemon-auto", ...)` 追加一行，验证靠日志而非"上下文里没看到"反推：

```
recall gate: kept=2 dropped=10 padding=9 reason=band|score|signal ms=214 chars=640 status=cached|spawn
```

## 7. USAGE_HINT 扩写（R4：深度检索改按需）

```
Use mnemon when it materially improves continuity. After responding, decide whether durable
preferences, decisions, insights, facts, or context should be stored with mnemon remember/link.
The recall above is a shallow pre-filter, not the whole store. For deeper retrieval run
mnemon recall "<focused query>" --intent WHY|WHEN|ENTITY --limit 10 --verbose
```

这是对齐 dsh `recallMode: guided`（"only when relevant evidence is missing"）和官方 skill（on-demand + `--intent`）的做法：**常驻的只留便宜且确定的内容，贵的检索交给模型按需发起**。

## 8. 权衡记录

1. **组合闸门 vs 照抄 dsh 阈值** → 组合。绝对阈值在本库不筛东西，相对带 + 信号判定才有效；代码里注释写明这个实测依据，避免后人"优化"回纯阈值。
2. **`--verbose` 全量 vs `--brief` 省 CPU** → verbose。token 是稀缺资源，CPU 不是；且 brief 没有 signals 就没有闸门。
3. **每条消息召回 vs 只在 SessionStart 召回** → 保持每条消息。召回质量依赖当前消息内容，SessionStart 拿不到它；用短查询门槛 + status 缓存 + 闸门压成本，"想要更多"由 §5 按需提示承接。
4. **短查询跳过会不会漏记忆** → 不会。短查询（`删`/`继续`）实测召回 0 证据项，而 runtime 段（最近对话）仍然注入，上下文连续性不受影响。

## 9. 兼容与回滚

- 改动集中在 `buildRecallContext` + 4 个新纯函数，**hook 注册面一行不动**，写侧路径零改动。
- 代码回滚 = 删除新增块，恢复 `runMnemon(["recall", query, "--limit", "5"], { cwd })` 一行。
- 运行时降级 = `MNEMON_RECALL=0`（不回滚代码即可 A/B 对照旧路径）。
- `docs/` 快照由 `npm run sync:docs` 从任务目录派生，README 属实时源文件，直接改。
