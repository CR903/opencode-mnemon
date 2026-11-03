# opencode-mnemon

基于 [mnemon](https://github.com/dsh) CLI 的 OpenCode 插件，提供**按项目隔离的自动记忆**。

对话回合在运行时被捕获、蒸馏（先规则、LLM 兜底），通过 `mnemon remember` 写回，并在每次模型调用前以临时副本形式重新注入一段经过质量闸门筛选的记忆。无需逐个用户配置：当项目存在 `<cwd>/.mnemon/` 时记忆落在项目本地，否则回退到 `~/.mnemon`。

## 安装

前置：`PATH` 上有 mnemon CLI：

```sh
npm install --global @mnemon-dev/mnemon
mnemon --version
```

全局注册一次即可——改 `~/.config/opencode/opencode.json`：

```json
{
  "plugins": [
    "opencode-mnemon"
  ]
}
```

或运行：

```sh
opencode plugin add opencode-mnemon
```

然后重启 OpenCode server（插件在启动时加载），验证：

```sh
opencode plugin list    # mnemon  x.y.z  opencode-mnemon
```

以后更新：`opencode plugin update opencode-mnemon`，再重启 server。

一份注册、一份拷贝。不要再往插件目录手放 `mnemon.js`，也不要在 npm 包已注册时跑 `mnemon setup --target opencode`——两种都会装出第二个同 id `"mnemon"` 副本，OpenCode 直接报 `Duplicate plugin ID` 中止，所有插件更新都被卡住。

## 它做什么

读写两侧共享同一个 mnemon 存储。

| 侧 | 触发 | 效果 |
|---|---|---|
| **写** | `session.text.ended` | 把回合追加到项目级 runtime 文件，60s 收尾窗口后 claim + 抽取 + `mnemon remember`（异步，SQLite BUSY 退避） |
| **读** | `context` hook（每次模型调用，临时副本） | 注入质量闸门筛选的召回段 + 缓存的一行状态 + 工作区文档提示 + 跨会话运行时回合。空召回时至多带状态行，否则空。`prompt` hook 只做写侧 stash，不改写 `prompt.text`，注入不进历史 |

三层结构，与 dsh-mnemon 对齐：

```
.mnemon/
  runtime/      每会话临时区（本插件持有 opencode-memories.json）
  data/         mnemon 存储（sqlite 图）
  documents/    只读：参与召回索引，绝不自动写入
```

## 召回质量闸门

`mnemon recall` 没有 `--min-score`，且 `--limit N` 在意图命中 WHY/WHEN/ENTITY 时用图/时间邻居补到 N——所以插件在注入前先做闸门过滤（task 10-11）：

- 少于 6 个非空白字符的消息完全跳过召回（实测「删」/「继续」零证据命中）。
- 结果过采样（`--limit 12 --verbose`），然后依次过滤：非法或 `>1` 的分数丢弃，`< 0.25` 丢弃，`< topScore − 0.15` 丢弃，`keyword+entity+similarity === 0` 视为 *padding*——只要有词法命中就丢弃 padding。全部都是 padding → 整段省略，连带文档/运行时/提示段一起省略：空召回的一轮至多带缓存的状态行（约 200 字符），状态为空则完全不注入。USAGE_HINT 只在有召回的轮次才配得上它约 330 字符的成本。
- 同会话的运行时条目默认排除：它们已在模型上下文里，重复是为同一段文本付两次钱。重启、新会话或压缩后自然恢复。`MNEMON_RUNTIME_SCOPE=all` 可恢复旧行为。
- 保留结果（≤ 4 条）渲染为紧凑行（`— [0.38·preference] excerpt…`，段 ≤ 900 字符）；约 30KB 的 verbose JSON 只喂 `JSON.parse`，绝不进模型上下文。状态段压缩为一行（≤ 200 字符），按记忆根缓存 60s。
- CLI 输出为空或不可解析（实测 `SQLITE_BUSY`）时 150ms 后重试一次，仍失败则丢弃该段——注入永不失败。
- 提示告诉模型深度检索是按需的：`mnemon recall "<focused query>" --intent WHY|WHEN|ENTITY --limit 10 --verbose`。

这是降噪，不是精确工程：本库分数聚集在 0.25–0.38，闸门只承诺零信号 padding 绝不进上下文。

## 硬性不变量

这些是承重墙。破坏它们会污染共享状态。

- **绝不写 `runtime/memories.json`。** 该文件是 dsh-mnemon 自己的运行时记忆，schema 不同（`{content, created_at, target, importance}`）。OpenCode 使用 `runtime/opencode-memories.json`（+ `.opencode-memories.lock`）。否则 50 条修剪会删掉 dsh 的条目。
- **绝不写 `documents/`。** 只建索引，不拥有它。
- **用租约，不用永久标记。** claim 写 `claimedAt`；超过 300s 的 claim 可被接管。永久标记曾卡住 11 条。
- **先规则抽取，LLM 只兜底。** `extractMemory(entry) ?? (await llmExtractMemory(entry))`。LLM 调用永不进入写锁，25s 超时（`unref`），失败静默回退规则结果。
- **LLM 入口是 `ctx.generate.text`，不是 session。** V2 `ctx` 上没有 `ctx.session.prompt`，`generate.text` 不会重新进入会话 prompt hook，所以没有递归。`[mnemon-extract]` 标记保留为文本级兜底。

## 部署模型

**推荐：从 npm 安装**。在全局 `~/.config/opencode/opencode.json` 的 `plugins` 数组声明发布包，由 OpenCode 自动拉取：

```json
{
  "plugins": [
    "opencode-mnemon"
  ]
}
```

OpenCode 会从 npm 安装到本地缓存（`~/.cache/opencode/npm/opencode-mnemon@latest/`），`opencode plugin list` 应看到 `mnemon` 插件。

**本地回退（不使用 npm 声明的环境）**：用仓库脚本复制到插件槽——注意是**复制**不是符号链接（R11 教训：仓库改名会让符号链接悬空、插件静默失效）。

```sh
npm run deploy                  # ~/.config/opencode/plugins/mnemon.js <- 仓库 mnemon.js（原子替换）
npm run deploy -- --check       # 只比对哈希，不写；漂移非零退出
npm run deploy -- --dry-run     # 打印将要做什么，不写
```

`deploy --check` 的退出码：`0` 同步 / `1` 漂移或源不可读 / `2` 从未部署。测试和 CI 可据此判断是否真的部署过，避免把"本机未部署"误判成"漂移失败"。

> ⚠️ 二选一：npm 声明和 copy 部署**只能留一个**。两者并存 = 同一个 `"mnemon"` id 注册两次，`plugin update` 直接报 `Duplicate plugin ID` 中止。用了 npm 版就别再 `npm run deploy`。

## 记忆层初始化（给新项目建库）

插件是全局的，记忆库按项目隔离：`<project>/.mnemon/` 存在即用项目库，否则回退全局 `~/.mnemon`。新项目建库：

```sh
cd <project>
npx opencode-mnemon-init         # 在 cwd 建 .mnemon/
npx opencode-mnemon-init <dir>   # 或指向别的目录
```

它创建 `runtime/`、`documents/{active,archived,index.json}`（空库写 `{"documents": []}`，已有不覆盖）和目录内 `.gitignore`（只忽略机器本地的 `data/` + `runtime/`，`documents/` 照常可版本化），最后用 `mnemon --data-dir … status` 证明 CLI 可达并预建 sqlite。幂等：已存在的文件一律保留。

它**绝不碰** `.opencode/` 和项目根 `.gitignore`。如果项目是老办法（官方 `mnemon setup --target opencode`）建的，残留的 `.opencode/plugins/mnemon.js` / `.opencode/skills/mnemon` 会触发警告——删掉它，它和 npm 包重复注册。

## 测试

```sh
npm test                          # 重建测试副本，然后跑全部五个套件
npm run test:deploy               # 同上，但针对 $PWD/mnemon.js 而不是 live 部署
```

套件：

| 文件 | 覆盖 |
|---|---|
| `tests/mnemon-recall-gate-test.mjs` | 召回闸门：查询下限、分数/带宽/信号过滤、紧凑行预算、状态压缩 + TTL 缓存 |
| `tests/mnemon-extract-test.mjs` | 规则抽取：标题、实体、类别、围栏比例、去重 |
| `tests/mnemon-remember-e2e.mjs` | 真实 `mnemon remember --data-dir` 往返；全局根隔离 |
| `tests/mnemon-llm-extract-test.mjs` | LLM 开关矩阵、模型目录解析、prompt/解析、超时、静默回退 |
| `tests/mnemon-init-test.mjs` | 初始化脚手架：全新布局、幂等重跑、显式目录、遗留重复警告、`--help`/`--version` |

测试从 `/tmp/mnemon-test-plugin.mjs` 导入——这是把内部实现附加为导出的插件副本。**编辑后务必运行 `tests/build-mnemon-test.sh`**，否则测的是过期副本。生产文件保持干净的 `{ id, setup, server }` 形状。

`build-mnemon-test.sh` 接受 `$1` 或 `$MNEMON_PLUGIN_PATH` 作为源路径；都不给时用 live 部署，无部署时回退仓库副本（全新 clone / CI）。设 `MNEMON_REQUIRE_DEPLOYMENT=1` 禁用回退。

### 环境变量覆盖

| 变量 | 作用 |
|---|---|
| `MNEMON_BIN` | e2e 套件驱动的 `mnemon` CLI 路径。默认取 `PATH` 上的裸 `mnemon`。 |
| `MNEMON_TASK_DIR_OPTIONAL=1` | 允许 `sync:docs:check` 在不存在 Trellis 任务目录时跳过。不设则失败——对不存在的东西做比对不是通过。 |
| `MNEMON_TEST_DST` | 导出的测试副本写入位置。默认 `/tmp/mnemon-test-plugin.mjs`。 |

CI（`.github/workflows/test.yml`）从 npm 安装 `@mnemon-dev/mnemon`——它公开发布、带各平台二进制、无需凭据——然后在临时 `HOME` 下跑套件，让回退断言碰不到真实记忆根。

## 开关

| 开关 | 范围 | 时机 |
|---|---|---|
| `<root>/opencode-llm-extract` | 按项目 | `touch` 开，`rm` 关，下轮 sweep 生效——无需重启 |
| `MNEMON_LLM_EXTRACT=1` | 进程 | 需重启 |
| `MNEMON_LLM_EXTRACT=0` | 进程 | 总闸，压过标记文件 |
| `MNEMON_LLM_MODEL` | 进程 | 压过标记文件的模型内容 |
| `MNEMON_LLM_MODELS` | 进程 | 逗号分隔 `provider/model`，整体覆盖默认模型链 |
| `MNEMON_AUTOMEM=0` | 进程 | 写侧关闭；**读侧保持开启** |
| `MNEMON_RECALL=0` | 进程 | 召回段关闭；注入至多带状态（文档 / 运行时 / 提示都关闭） |
| `MNEMON_RUNTIME_SCOPE=all` | 进程 | 运行时段包含同会话条目（默认只跨会话） |
| `MNEMON_DEBUG=0` | 进程 | 插件日志完全关闭 |
| `MNEMON_DEBUG_LOG=<path>` | 进程 | 覆盖插件日志路径（默认 OS 临时目录 `mnemon-plugin-debug.log`） |
| `MNEMON_DISABLE=1` | 进程 | 总闸，**读写两侧都停止**（`TRELLIS_HOOKS=0` / `TRELLIS_DISABLE_HOOKS=1` 作 legacy 兼容保留） |

标记文件的非空内容被视为模型 ID。

**环境开关是进程级的。** 每个插件实例都活在后端常驻的 OpenCode *server* 进程里，所以 `MNEMON_DISABLE=1 opencode run ...` 无效——`opencode run` 是客户端，环境变量到不了 server。请在启动 server 的环境里导出。这也意味着环境开关无法按项目隔离；要按项目用标记文件。

## LLM 模型解析

模型按 live 目录解析，绝不硬编码——硬编码一个不在 `ctx.model.list()` 里的 provider，每次调用都会失败。

- `pickModelRef(models, wanted)` 按 `[configured, ...llmModelChain()]` 顺序搜索。目录为空 → 信任配置；无匹配 → `null` 并静默放弃。
- 默认链 `["opencode-go/qwen3.8-flash", "opencode-go/deepseek-v4-flash", "opencode-gemini-3.5-flash-lite", "opencode-go/longcat-2.5-preview-free"]`，`MNEMON_LLM_MODELS`（逗号分隔 `provider/model`）可整体覆盖。`LLM_MODEL_CHAIN` 保留作兼容别名。
- `ctx.model.list()` 返回 `{ location, data }` ——取 `.data`。
- 模型引用必须是 `{ id, modelID, providerID }` 且 **`id` 必须是裸 modelID**。传完整 `provider/model` 字符串会被重新拼成 `provider/provider/model`。只有 `{ id }` 会报 `Missing key at ["model"]["providerID"]`；裸字符串报 `Expected Model.Ref | null`；省略 `model` 命中免费档，它会拒绝 OpenCode 外部的调用。

以上全部是探测出来的，不是读文档读出来的。

## mnemon 调用

`PATH` 上的 `mnemon` 是 npm JS 启动器；`SIGKILL` 它会留下孤儿原生子进程。`mnemonCommand()` 解析真实原生二进制一次并缓存：`realpathSync` 检测 `bin/mnemon.js` → 读 `targets.json` 找平台/架构匹配 → `createRequire` 解析 optional 依赖。win32 走 `.cmd` shim 分支。解析到例如 `.../@mnemon-dev/mnemon-darwin-x64/bin/mnemon`。

## 时序常量

| 常量 | 值 |
|---|---|
| `MIN_AGE_MS` / `FINALIZE_MS` | 60 000 |
| `BATCH` | 3 |
| `MIN_TOTAL_CHARS` | 24 |
| `SUBSTANTIVE_CHARS` | 60 |
| `MAX_FENCE_RATIO` | 0.7 |
| `ASSISTANT_CHARS` / `USER_CHARS` / `HEADLINE_CHARS` | 700 / 150 / 110 |
| `MAX_ENTITIES` / `MIN_IMP` | 8 / 3 |
| `BUSY_RETRY_MS` | 350 |
| `TAIL_DELAY_MS` | 75 000 |
| `CLAIM_LEASE_MS` | 300 000 |
| `MIN_RUNTIME_TEXT_CHARS` | 20 |
| `RUNTIME_RECENT_COUNT` | 5 |
| `LLM_TIMEOUT_MS` / `LLM_MAX_ENTITIES` | 25 000 / 6 |
| `RECALL_LIMIT` / `RECALL_MAX` | 12 / 4 |
| `RECALL_MIN_SCORE` / `RECALL_BAND` | 0.25 / 0.15 |
| `RECALL_MIN_QCHARS` | 6 |
| `MAX_QUERY_CHARS` | 8000 |
| `RECALL_CACHE_MAX` | 128 |
| `STATUS_TTL_MS` | 60 000 |
| `RECALL_SECTION_MAX_CHARS` / `STATUS_SECTION_MAX_CHARS` | 900 / 200 |

`MIN_RUNTIME_TEXT_CHARS` 会**静默**丢弃过短回合——探针回个「好」看起来像管线坏了。其实不是。

## 调试

- 插件日志：`$TMPDIR/mnemon-plugin-debug.log`（`MNEMON_DEBUG_LOG` 覆盖，`MNEMON_DEBUG=0` 关闭），grep `mnemon-auto`（append / remember / `llm extract ok|drop|skipped` / sweep / lease / `recall gate: kept= dropped= padding= reason= ms= chars= status=cached|spawn` / `context inject`）。8MB 轮转到 `.log.1` / `.log.2`，诊断中途轮转也能读上一代。流式事件不再逐条记日志。
- 加载日志：`~/.local/share/opencode/log/opencode.log`，`loading plugin` / `failed to load plugin`——原始计数有虚高，用 `grep -av "spawning process"` 过滤。

## 项目约定

- 配置文件（JSON、`.env`、`package.json`）用 **tabs**，不用空格。
- 本仓库是唯一事实来源。没有项目级副本：`BalanceDeck/.opencode/plugins/mnemon.js` 已作为过时 fork 删除。

## 文档

`docs/prd.md`、`docs/design.md`、`docs/implement.md` 保存需求、技术设计与带验证证据的执行记录。Trellis 任务目录 `~/project/others/.trellis/tasks/10-11-mnemon-recall-gate/` 是工作副本；`docs/` 是它的一向快照，因为该任务目录不受任何版本控制，所以 `docs/` 留在 git 里。

编辑任务文档后同步：

```
npm run sync:docs          # 把 prd/design/implement 复制到 docs/
npm run sync:docs:check    # 只报漂移；有漂移非零退出
```

`npm test` 会跑这个检查，所以快照过期套件就会失败。`docs/` 是派生品：绝不要直接编辑它，下次同步会覆盖。

脚本无论任务目录还在活跃（`tasks/<slug>/`）还是已归档（`tasks/archive/<YYYY-MM>/<slug>/`）都能找到——归档会移动它，而已归档任务仍是事实来源。用 `MNEMON_TASK_DIR=...` 或位置参数覆盖。

**找不到任务目录时检查失败而不是通过。** 找不到源就等于没验证任何东西，干净退出看起来像在保护却什么都没查。在确实没有 Trellis 任务目录的机器上，显式退出：

```
MNEMON_TASK_DIR_OPTIONAL=1 npm test
```

`sync:` 不覆盖 `tests/`。它们是这里的活代码，不是快照，绝不会从任务目录写入。`build-mnemon-test.sh` 有意与归档副本不同——仓库版本接受 `MNEMON_PLUGIN_PATH` 和路径参数并校验源存在，归档版硬编码 live 部署路径。归档副本保持原样：它是该任务产出的冻结记录，改写它就是在歪曲历史。