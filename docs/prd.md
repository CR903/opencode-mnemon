# mnemon recall 质量闸门与 token 优化

## Goal

让 opencode-mnemon 插件的读侧注入"更少、更快、更准"：无关记忆不再进上下文，注入体积降到现状 1/3 以内，同时给模型留一条按需深度检索的路。对标标准为 dsh-mnemon 的 `recallQuality: strict-v1`。

## Background（2026-10-11 实测，仓库 `/Users/zhouri/project/others`）

现状读侧链路（`mnemon.js:466` → `buildRecallContext` `mnemon.js:337`）每条用户消息注入四段：

| 段 | 来源 | 实测体积 |
|---|---|---|
| `Status:` | `mnemon status`（spawn #1，129ms） | 1476 字符 |
| `Relevant recall:` | `mnemon recall <q> --limit 5`（spawn #2，186ms） | 4616 字符 |
| Workspace documents | `documents/index.json`，token 打分（**已有阈值** `MIN_DOC_SCORE=3`） | ≤700 字符 |
| Recent runtime turns | `runtime/opencode-memories.json` | ≤2048 字符 |
| USAGE_HINT | 常量 | ≈200 字符 |
| **合计** | | **≈9000 字符 / 条消息** |

召回质量实测（`--verbose` 看信号）：

| 查询 | 结果 | 信号 |
|---|---|---|
| `删` | 5 条，score 全 = 0.30 | keyword=0 entity=0 similarity=0，仅 graph/temporal |
| `为什么每次给opencode发消息调取mnemon` | 5 条，0.23–0.30 | 同上，全 0 |
| `dsh-mnemon 的召回质量闸门标准是什么`（limit 12） | 12 条，0.24–0.31 | 分数全挤在 0.25–0.38 区间 |

根因：`mnemon recall` **没有 min-score 参数**，`--limit N` 是硬凑满；intent 自动识别（WHY/WHEN/ENTITY）会切到图遍历，返回的是"图邻居 + 最近条目"而非匹配项。CLI 无 `--min-score`，闸门只能在插件层做。

已排除的方案：`--basic`（SQL LIKE）对中文整句 **0 命中**（把整句当一个 LIKE 模式），只有单字查询 `删`/`提交` 才有结果；`--brief --verbose` 组合输出为空（不可用，拿不到 signals）。

## Requirements

- **R1 质量闸门（A）**：recall 结果经分数 + 信号过滤后才渲染；过滤后为空 → **整段不注入**（宁可沉默也不上噪声）。
- **R2 短查询门槛（B）**：非空字符数低于阈值的查询不跑 recall，只注入 runtime + docs + hint（`删`、`继续`、`提交` 这类消息本来也召不回东西）。
- **R3 缓存与降级（C）**：`status` 进程级 TTL 缓存（60s），每条消息最多 1 次 spawn；CLI 空输出 / 非 0 退出 / `SQLITE_BUSY` → 重试一次，仍失败则**静默跳过该段**，注入本身永不失败。
- **R4 深度检索改按需（D）**：注入只保留浅层 top 摘要；USAGE_HINT 明确告知模型"要更多就自己跑 `mnemon recall "<聚焦查询>" --intent WHY|WHEN|ENTITY --limit 10`"。召回段为空时也给出这句提示，而不是留白。
- **R5 文档同步（E）**：`README.md` 第 5 行写的"inject on the next SessionStart / idle turn"与实际"每条 prompt"不符，改为与实现一致，并补读侧闸门说明。
- **R6 Token 预算（核心新需求）**：
  - 注入总字符 ≤ **3000**（现状 ≈9000，降幅 ≥66%）
  - `Relevant recall` 段 ≤ **900**
  - `Status` 段 ≤ **200**（压缩成单行）
  - 召回结果以**紧凑行**渲染（`— [0.38·preference] 摘录≤120c`），不再注入 CLI 原始 JSON
- **R7 可观测**：debug log（`/tmp/trellis-plugin-debug.log`）记录本次 recall 的 `kept/dropped/reason/chars/ms`，验证时能用日志证明闸门生效，而不是靠"上下文里没看到"反推。

## Acceptance Criteria

- [ ] 新增单测覆盖闸门：padding-only 查询（全 0 信号）→ 0 条；带 lexical 命中 → ≤4 条；分数带过滤生效；短查询不触发 recall；status 缓存命中不再 spawn
- [ ] `npm test` 全绿（现基线 132 项 + 新增项）
- [ ] headless 探针实测：真实 `<mnemon_context>` 总字符 ≤3000，recall 段 ≤900，status 段 ≤200
- [ ] 探针日志出现 `recall gate: kept=N dropped=M ...` 字样，且 dropped>0（对 padding 查询）
- [ ] 对 `删` / `继续` 这类短查询，注入体中**不含** `Relevant recall` 段
- [ ] status 在 60s 内只 spawn 一次（日志可证）
- [ ] CLI 返回空 / 报错时注入仍成功，且不含空段
- [ ] `npm run sync:docs:check` 通过（docs/ 快照与任务目录零漂移），README 描述与实现一致

## Constraints

- 不改 mnemon CLI 本体、不写 `documents/`、不碰 dsh 的 `runtime/memories.json`（硬不变式）
- 不新增 npm 依赖，只用 node 内置模块
- 配置文件一律 tabs
- 保留既有 kill switch 语义：`TRELLIS_HOOKS=0` 关全部；`MNEMON_AUTOMEM=0` 只关写侧；**新增** `MNEMON_RECALL=0` 只关 recall 段（进程级，A/B 对照用）
- 召回过滤是"降噪"不是"提精度"：本库分数天花板只有 0.38，闸门不承诺语义准确率，只承诺不把 0 信号的凑数项送进上下文
