# 执行计划：recall 质量闸门与 token 优化

仓库：`~/project/opencode-mnemon-plugin`（部署槽 `~/.config/opencode/plugins/mnemon.js` 是指向仓库 `mnemon.js` 的符号链接，改仓库即改生产）。
所有命令除非注明，均在仓库根目录执行。

## 步骤 0 · 基线（先量再改）

- [ ] `npm test` 记录基线（现 132 项 + sync:docs:check），必须全绿
- [ ] headless 探针取注入基线：
      ```sh
      cd /Users/zhouri/project/others && opencode run "这是基线探针：mnemon 插件的注入体积是多少"
      grep -a "injectedChars" /tmp/trellis-plugin-debug.log | tail -3
      ```
      记下 `injectedChars`（预期 ≈7000–9000，对应 PRD Background 表）
- [ ] 抓一份真实 `recall --verbose` 样本存进测试 fixture 目录（闸门单测要复现 padding-only 与 lexical-hit 两种形态）：
      ```sh
      cd /Users/zhouri/project/others
      mnemon recall "删" --limit 12 --verbose > /tmp/fixture-padding.json
      mnemon recall "mnemon 插件测试怎么跑" --limit 12 --verbose > /tmp/fixture-lexical.json
      ```
      **验收**：两份 fixture 都能 `JSON.parse`；padding 那份全部条目 `keyword+entity+similarity === 0`

> 若基线探针的日志里字段与预期不符（旧代码在跑），说明常驻 server 没重载插件 → 先重启 OpenCode server 再测（`grep -a "loading plugin" ~/.local/share/opencode/log/opencode.log` 确认），否则后面所有测量都测的是旧代码。

## 步骤 1 · 纯函数（唯一新代码面）

- [ ] 常量块（紧跟 `MAX_RECALL_CHARS` 附近，值必须与 design.md §3 一致，注释写明实测依据）：
      `RECALL_LIMIT=12`、`RECALL_MIN_SCORE=0.25`、`RECALL_BAND=0.15`、`RECALL_MAX=4`、`RECALL_MIN_QCHARS=6`、`STATUS_TTL_MS=60_000`
- [ ] `gateQuery(query)` → boolean（非空字符数 ≥ `RECALL_MIN_QCHARS`）
- [ ] `gateRecallResults(payload, opts)` → `{ kept, dropped, padding, topScore }`
      过滤顺序按 design.md §3：score 合法性 → 绝对阈值 → 相对带 → 信号判定（padding-only 返回空 kept）
- [ ] `renderRecallSection(gated)` → `string | null`（`null` = 整段不注入；行格式 `— [score·category] 摘录≤120c`，段头 `Relevant recall (N/M kept, scores are weak evidence):`）
- [ ] `compressStatus(json)` → `string`（≤200c 单行；解析失败退回原样截断）

## 步骤 2 · 接线 `buildRecallContext`

- [ ] `MNEMON_RECALL=0` → 跳过 recall 段（进程级开关，读侧专用）
- [ ] `getStatusSection(root)`：60s TTL 进程级 Map（键 = memory root），命中不 spawn
- [ ] `runRecall(query, cwd)`：`runMnemon(["recall", query, "--limit", String(RECALL_LIMIT), "--verbose"])`；空输出 / `JSON.parse` 失败 → 150ms 后重试 1 次 → 仍失败返回 `null`
- [ ] 组装顺序与预算：status(≤200) → recall(≤900) → docs(不变) → runtime(剩余预算) → hint
- [ ] 短查询 / 闸门后为空 / recall 失败 → 对应行提示（design.md §5 表），**注入永不抛错**
- [ ] `debugLog` 输出 `recall gate: kept= dropped= padding= reason= ms= chars= status=cached|spawn` + 各段字符数

**回滚点 A**：`git checkout -- mnemon.js` + `npm run deploy`，回到基线。

## 步骤 3 · USAGE_HINT 扩写（R4）

- [ ] 追加"浅层预过滤，深度检索自行执行 `mnemon recall "<q>" --intent WHY|WHEN|ENTITY --limit 10 --verbose`"
- [ ] 空召回提示行按 design.md §5 原文写入

## 步骤 4 · 单测

- [ ] 新增 `tests/mnemon-recall-gate-test.mjs`（用步骤 0 的 fixture，离线、确定性）：
      - padding-only → `kept.length === 0`、`renderRecallSection` 返回 `null`
      - lexical-hit → `kept ≤ 4`、相对带生效（tail 被 drop）、分数升序渲染
      - `gateQuery("删") === false`、`gateQuery("dsh-mnemon 的召回质量闸门标准") === true`
      - `compressStatus` ≤200c 且含 insight/edge 计数；坏 JSON → 截断兜底
      - 预算断言：`renderRecallSection` 输出 ≤900c、`compressStatus` ≤200c
      - `--limit 12 --verbose` 输出体积 <200KB（防 CLI 输出膨胀打爆 `maxBuffer`）
- [ ] `package.json` 的 `test` / `test:deploy` 脚本串上新套件（tabs 缩进）
- [ ] 改完**必须**先 `sh tests/build-mnemon-test.sh` 再跑（否则测的是旧副本）

## 步骤 5 · 全量回归 + 部署

- [ ] `npm test`（含 `sync:docs:check`）全绿
- [ ] `npm run deploy`（原子换符号链接，不留空窗）

**评审门 1**：`npm test` 全绿后才进步骤 6。

## 步骤 6 · 真实链路验证（headless 探针）

```sh
cd /Users/zhouri/project/others
opencode run "mnemon 插件的 recall 质量闸门是怎么过滤的，详细说说"   # 长查询
opencode run "删"                                                     # 短查询
grep -a "recall gate\|injectedChars" /tmp/trellis-plugin-debug.log | tail -6
```

- [ ] 长查询：`kept≥1 dropped≥1`、`chars` 总注入 ≤3000、recall 段 ≤900、status 段 ≤200
- [ ] 短查询：日志显示 recall 被跳过（`reason=short-query`），注入体无 `Relevant recall`
- [ ] `status=cached` 在 60s 内出现（第二条探针）
- [ ] 若日志字段仍是旧的 → server 未重载，重启后重测（**测量无效就不算数**）

**评审门 2**：PRD Acceptance Criteria 逐条勾，附日志原文。

## 步骤 7 · 文档（R5）与快照

- [ ] `README.md`：修第 5 行"inject on SessionStart / idle turn"→ 与实现一致；Switches 表加 `MNEMON_RECALL=0`（进程级）；Timing constants 表补 5 个新常量
- [ ] `npm run sync:docs`（prd/design/implement 派生进 `docs/`），再 `npm run sync:docs:check` 零漂移

## 步骤 8 · 收尾

- [ ] Phase 3.3：若本任务挖出可复用契约（如"recall 无 min-score、padding 判据是信号而非分数"）→ `trellis-update-spec` 沉淀进 `.trellis/spec/opencode-plugin/`
- [ ] Phase 3.4：提交（仓库 `opencode-mnemon-plugin` 是独立 git 仓库，注意 `~/project/others` 本身不是 git 仓库——任务目录不进版本控制）
- [ ] 汇报：before/after 注入体积、闸门统计、验收勾选表

## 验证命令速查

```sh
sh tests/build-mnemon-test.sh          # 改完必跑
npm test                               # 全量（含 sync:docs:check）
npm run deploy                         # 部署（符号链接原子替换）
npm run sync:docs && npm run sync:docs:check
grep -a "mnemon-auto" /tmp/trellis-plugin-debug.log | tail -20
```
