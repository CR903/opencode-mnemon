# Design: OpenCode mnemon自动记忆

## Boundaries

- 改动面：`~/.config/opencode/plugins/mnemon.js`（主）+ `BalanceDeck/.opencode/plugins/mnemon.js`（同步补丁，保持既有分叉逻辑不动）。SqlDiff / smarterlab / others 无项目级副本，走全局。
- 不碰：mnemon CLI 本体、dsh 侧、`documents/` 写路径、其它 13 个插件。
- 与已归档子任务的关系：`--data-dir` 解析是本任务的前置（已落地），本任务只加“写侧”与“文件层”。

## Contracts & Data Flow

- 读侧（prompt hook，`ctx.session.hook("prompt")`，沿用现有）：
  1. `mnemon --data-dir <root> status/recall`（记忆空间，现有逻辑不动）；
  2. 读 `<root>/runtime/memories.json` 尾部 N 条（运行时记忆，有界，如最近 5 轮、总 ≤2KB，超裁旧）；
  3. 读 `<root>/documents/index.json` 做关键词检索，命中标题/摘要才在正文后附“按需阅读清单”（只给相对路径，不贴全文）。
- 写侧（新增，`ctx.event.subscribe` 后台消费，不阻塞 setup，卸载时 abort——沿用 `feishu-notify.ts:115` 模式）：
  - 事件源：`session.idle`（主）或 `session.text.ended` 累积（备选，取先验证通的那个）。
  - reminisce：把本轮（user prompt + assistant 全量文本）发给一个有界摘要器，输出 `remember` 候选（content / cat / imp / entities）或空。
  - 摘要器选型：A) `ctx.generate.text({ prompt, model: { id } })` 一次性调用（V2 `ctx` 上无 `ctx.session.prompt`，已探测确认）；B) 本地规则（长度/关键词门槛，零成本，召回弱）。B 保底常开，A 只在 B 判空时补抽一次，文件标记或 env 开启。
  - 写入：`mnemon --data-dir <root> remember ...`（串行，BUSY 退避一次）；同时 append `runtime/opencode-memories.json`（总是成功，不依赖 sqlite）。

## Tradeoffs

- LLM 抽取（准、贵、有循环风险）vs 规则抽取（便宜、弱、无风险）：先 B 后 A，开关控制。
- `session.idle` 可能晚到/不触发：以 `compaction` 钩子兜底（已有提示词），保证压缩前必有一次模型驱动的 remember 机会。

## Compatibility & Rollout

- 全功能默认关闭？否：读侧保持现状；写侧默认开但保守阈值。三道闸：`TRELLIS_HOOKS=0` / `TRELLIS_DISABLE_HOOKS=1` 总关（读写两侧全停，与 BalanceDeck 三个本地插件同款 `hooksDisabled()`）；`MNEMON_AUTOMEM=0` 只关写侧、保留读侧 recall 注入；`MNEMON_LLM_EXTRACT` 与 `<root>/opencode-llm-extract` 标记文件控 A 方案。
- **env 开关是进程级的，插件实例全在常驻 server 进程里**：`opencode run` 只是连到该 server 的客户端，所以 `TRELLIS_HOOKS=0 opencode run ...` 无法生效（A/B 探针实测：headless 端无 `skipped` 日志，append 仍由 server 端完成）。env 开关必须在**启动 OpenCode server 的环境**里 export 才生效，且不能按项目区分。这正是 A 方案开关选择"文件标记优先、env 兜底"的原因。
- 回滚：删新增代码块即回退到已归档状态（纯加法改动，无 schema 变更）。

## Open Questions

- ~~`session.idle` / `session.text.ended` 在当前 OpenCode 版本事件流中的实际 payload~~ **已关闭**：`session.text.ended` 带 `sessionID` + 当轮 assistant 全文；`session.idle` 在本版本从不触发，写侧改用 `text.ended` + 定稿窗口 + 尾部重扫。
- ~~`ctx.session.prompt` 临时会话是否触发本插件 prompt hook~~ **已关闭（前提不成立）**：V2 `ctx` 上没有 `ctx.session.prompt`。改用 `ctx.generate.text`，它不经过 session prompt hook，故无递归风险；`[mnemon-extract]` marker 仍保留作为兜底（防未来版本行为变化）。
- A 方案开关的生效范围。**已定为文件标记优先**：`<root>/opencode-llm-extract` 按项目生效、`touch`/`rm` 即时生效、无需重启进程；env 保留作进程级开关与 `=0` 总闸。理由：env 依赖启动 OpenCode 时的进程环境，且无法区分 BalanceDeck 与 others 两个项目。
- ~~`ctx.generate.text` 的 `model` 参数形状~~ **已关闭（探针实测，非文档可得）**：`ctx.model` / `ctx.provider` 不在公开的 `PluginContext` 类型里，签名只能靠运行时探测。结论：`model` 必须是 `{ id, modelID, providerID }`，`id` 只能是裸 modelID（传 `provider/model` 会被拼成 `provider/provider/model`）；且该模型必须在 `ctx.model.list().data` 中（返回体是 `{location, data}`，需取 `.data`）——当前 73 个模型不含 `sensenova`，故 `sensenova/*` 硬编码必然失败。不传 `model` 走免费档报 `OpenCode's free tier can only be used from within OpenCode`。因此模型必须**按目录解析**（`pickModelRef`），不能硬编码名字；这对 BalanceDeck 同步（步骤 7）是硬约束。
