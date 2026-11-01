# Mnemon 记忆隔离机制：验证结论

> 验证日期：2026-11-01
> 验证对象：`opencode-mnemon-plugin`（部署槽 `~/.config/opencode/plugins/mnemon.js` → 仓库 `mnemon.js`）
> 触发背景：用户反馈"每次问问题都有和本项目无关的记忆被提取"，怀疑 mnemon 是全局存储。

## 结论速览

| 问题 | 答案 |
|---|---|
| 记忆存储是全局还是按项目？ | **按项目隔离**（项目根存在 `.mnemon` 时） |
| 搜索/召回走哪个库？ | 与存储一致：`resolveMemoryRoot(cwd)` 决定 |
| 当前会话用哪个库？ | 项目库（`<项目>/.mnemon/data/default/mnemon.db`） |
| 为什么偶尔看到无关记忆？ | ① 项目没有 `.mnemon` → fallback 全局库；② 子代理模板记忆（"subagent spawned"）污染项目库 |
| 插件/skill 装全局会不会串记忆？ | **不会**。代码全局共享，数据按项目解析 |

## 核心机制

插件读/写侧都通过 `resolveMemoryRoot(cwd)` 决定数据目录（`mnemon.js`）：

```js
function resolveMemoryRoot(cwd) {
  const project = resolveProjectDataDir(cwd)  // cwd 下有没有 .mnemon？
  if (project) return project                  // 有 → 用项目本地库
  return join(process.env.HOME || "", ".mnemon") // 没有 → fallback 全局库
}
```

对应的 CLI 参数是 `--data-dir <root>/.mnemon`。

- **`mnemon setup --target opencode`** 安装的是**代码层**（skill / prompt / plugin），默认项目本地（`.opencode/`），加 `--global` 才装到 `~/.config/opencode/`。
- **记忆数据**在运行时按 `cwd` 解析，与插件安装位置无关。
- 因此**全局装插件 + 项目本地数据**是推荐形态：一份代码，N 个隔离库。

## 实测证据（2026-11-01）

| 项目 | `.mnemon` 存在 | 独立库 | 说明 |
|---|---|---|---|
| BalanceDeck | ✅ | ✅ 2584 edges | 本次会话用的就是它 |
| others | ✅ | ✅ 122 active（子代理记忆保留；仅清 5 条重复/过时） | 早已隔离 |
| SqlDiff / cordis-course / knowfolio / smarterlab / phantomBeastCardDuel | ✅ | ✅ | 均已隔离 |
| feishu-notify | ✅（2026-11-01 补） | ✅ 新库，0 edges | 已建立独立库，`.mnemon/` 已入 .gitignore |

> 注意：`mnemon` CLI **不按 cwd 自动选库**——裸跑读的是全局 `~/.mnemon`。
> 核对项目记忆必须显式 `--data-dir <root>/.mnemon`（参见库内记忆 `22460b92`）。

## "无关记忆"的两个真实来源

### 1. 项目没有 `.mnemon` → fallback 全局库

这是最危险的串库路径。例如 `feishu-notify` 没有 `.mnemon`，在其目录下工作时会读写全局库，把 feishu 相关记忆混进全局；其他没有 `.mnemon` 的项目又会在全局库里看到它们。

**对策**：每个需要隔离的项目根执行一次项目本地初始化（或手动建 `.mnemon` 目录）：
```bash
cd /path/to/project && mnemon setup --target opencode --yes
```

### 2. 子代理模板记忆污染项目库

子代理（`trellis-implement` / `trellis-check` / `trellis-research`）会话被自动记录时，整个注入 prompt（以 "You are a subagent spawned by another session" 开头）被当成记忆入库（`--source agent`）。

实测：others 项目库 125 条记忆中 **32 条** 是这种模板记忆，占 1/4 以上，recall 时高频命中、与项目任务无关。

**对策**：
- 清理存量：按内容特征批量 `mnemon forget`（软删除）。
- 防新增：在插件写侧跳过子代理会话（类似读侧已有的 `isTrellisSubagent` 过滤）。

## 维护建议

1. 不要在每个项目都跑 `mnemon setup`——**全局装一次插件**，各项目只需有 `.mnemon` 数据目录。
2. 定期检查项目记忆归属：
   ```bash
   mnemon --data-dir /path/to/project/.mnemon status
   # db_path 应显示项目路径，而不是 ~/.mnemon
   ```
3. 检查是否有项目缺 `.mnemon`：
   ```bash
   for d in ~/project/*/; do [ -d "$d/.mnemon" ] || echo "缺 .mnemon: $d"; done
   ```
4. 过时记忆用 `mnemon forget <id>` 软删除，不要手动删 SQLite 行（会破坏 oplog / 边）。