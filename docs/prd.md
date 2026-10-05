# OpenCode mnemon自动记忆

## Goal

参考 dsh-mnemon（v0.5.24，三层：运行时记忆 / 项目档案 / 记忆空间，存储范围=工作区），在 OpenCode 实现对等的自动记忆。底层同为 mnemon CLI（dsh 侧 Mnemon Native 0.2.10），目录同构（`<workspace>/.mnemon/{runtime,data,documents}`），故读写可互通。

## Requirements

- 存储范围=工作区：读写根为 `<cwd>/.mnemon`（无则回退全局），与 dsh 同址，`data/`（记忆空间）、`runtime/`（运行时记忆）、`documents/`（项目档案）三层共用。
- 自动记录：`session.idle` 后台 reminisce，LLM 判断本轮值得长期保留的事实并 `remember`（对标 dsh「主动记录」）， Pickup率可配（环境变量开关 + 重要性阈值）。
- 运行时记忆：每轮确定性落盘（user prompt + assistant 全量文本摘要）到 `runtime/`，prompt 时注入最近 N 轮（对标 dsh「运行时记忆常驻」）。
- 项目档案：prompt 时先检索 `documents/index.json`，命中再按需读全文（对标「先检索再按需阅读全文」）；只读，不自动写。
- 防循环：写入动作不得再次触发 prompt/tool 钩子；单轮写入有上限；失败静默。

## Constraints

- OpenCode 插件无 UI 插槽：dsh 的「回合记忆栏 / 存入记忆按钮」不做，用 compaction 提示 + 手动 `remember` 命令覆盖。
- 不与 dsh 并发写同一 sqlite 无锁：写操作串行化，`SQLITE_BUSY` 时退避重试一次，仍失败则降级只写文件层。
- token 成本： reminisce 调用有上限（每 idle 最多 1 次，只在有实质对话轮次时触发）。

## Acceptance Criteria

- [x] 工作区会话的 recall/status 命中 `<cwd>/.mnemon`（回归通过：`status` 的 `db_path` 落在 `<workspace>/.mnemon/data/default/mnemon.db`）
- [x] 一轮有实质内容的对话结束后 `data/` 库新增 insight（生产实测 5 条：fact 2 / insight 1 / preference 2，`log` 含 remember）。触发器为 `session.text.ended` + 60s 定稿窗口 + 下一事件或 75s 尾部重扫（非 `session.idle`，见 implement.md 步骤 1）。dsh 侧可见：读写同一 `<workspace>/.mnemon/data` 库，`mnemon --data-dir <workspace>/.mnemon recall/status` 即 dsh 的同一地址；dsh 自己的 `runtime/memories.json` 字节与 mtime 均未变。
- [x] `runtime/` 每轮追加记录（`opencode-memories.json`，50 条封顶、每段 ≤2000 字），prompt 注入最近 5 条且预算有界（实测注入块 523–2455 字）
- [x] `documents/` 只读：仅读 `documents/index.json` 做关键词命中，实测 mtime 未变、无写入
- [x] 连续多轮无重复注入、无钩子递归：约 2 小时内 prompt hook 仅 10 次调用（≈每轮 1 次），跨进程/同批重复写入均被 `rememberKey` 去重拦下
- [x] A 方案（LLM 补抽）默认关闭、可配开启，开启不影响规则路径：`<root>/opencode-llm-extract` 文件标记按项目生效（`touch` 即开、`rm` 即关，无需重启进程，文件内容可写模型 ID），`MNEMON_LLM_EXTRACT=1` 进程级开启、`=0` 为总闸且压过标记文件；模型异常/超时静默回退到规则结果，`[mnemon-extract]` marker 防递归。验证：`tests/mnemon-llm-extract-test.mjs` 69 项全 PASS（含开关矩阵、模型目录解析降级、模型引用形态单测、npm-shim 解析、总闸行为矩阵与 setup 接线，以及「规则命中的轮次不消耗 LLM」）。**已生产验证**：headless 探针一轮无信号词的对话经规则丢弃后由真实模型抽出（`cat: preference imp: 5 chars: 251`）并 `remember ok`，`recall` 以 0.725 取回。
- [x] 无 `.mnemon` 项目行为不变（回退全局）：`resolveMemoryRoot` 回退到 `~/.mnemon`，全局根 `~/.mnemon/runtime/opencode-memories.json` 在 `/tmp` 下无 `.mnemon` 的 headless 探针中被首次创建且条目落盘。dsh 的全局 `runtime/memories.json` 全程 11 条、sha256 `4ea85af594ac` 未动；探针污染（2 条 db 记忆 + 2 条 runtime 条目）已清。
- [x] `failed to load plugin` 为零，其余插件不受影响：最后一次加载失败停在步骤 5 的编辑中间态（03:29:58），此后热重载数十次无一失败；8 个插件（全局 5 + BalanceDeck 3）全部加载成功。

## Notes

- 复杂任务：另见 `design.md`（技术设计）与 `implement.md`（执行计划），三者齐后方可 `task.py start`。
