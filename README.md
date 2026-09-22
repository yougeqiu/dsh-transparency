# dsh-transparency

Transparent-agent spike plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — **context editing as session-log projections**.

对运行中的 Agent 会话直接编辑"模型可见的上下文"：改文本、删消息、加批注、区间删除、回退版本——所有修改都以 append-only 的一方事件落进 session 日志，不引入任何外挂事件类型。

> ⚠️ 这是一个 spike / 原型插件。它依赖 DSH 运行时提供的 `@deepseek-ai/dsh-*` 包（session surface、agentLoop、compaction 等），不能脱离 harness 独立运行。

## 设计约束（为什么这样实现）

- **零外挂事件类型**：DSH 的 `KNOWN_SESSION_EVENT_TYPES` 是编译期集合，含未知事件的日志在其他 harness 构建上无法重开。所以所有编辑操作都落成一方事件（`user/message`、`system/message` …）+ `surfaceOp: { op: 'replace' }`，编辑后的日志对任意 harness 仍可重开、可回放。
- **编辑 = 换头**：`replace` surfaceOp 让新事件遮蔽目标 seq 区间，原事件保留在日志里 → 天然得到版本链（git 式 revert = 再 append 一条同内容的 replace）。
- **先预演后落库**：每批 op 先在 wire 投影副本上跑 `validateWire`（孤儿 tool-call / 空消息守卫），整批合法才 append 真实事件；改 tool-call id 时自动生成配对 op 同步 `tool-result.toolCallId`。
- **hold 门控**：挂 `agent/pre-step` 钩子，扣住会话的下一步请求（once / sticky 两档），检查修改后放行——跑偏当轮截停。

## 组成

| 文件 | 作用 |
|---|---|
| `src/plugin.mjs` | Cordis function 插件入口：`inject = [sessions, agents, agentLoop, compaction, sessionQuery]`，注册 pre-step 门控、提供 `transparency` 服务、启动 HTTP 面板（默认 127.0.0.1:4173） |
| `src/apply.mjs` | `applyOps(session, ops)`：edit / annotate / delete / deleteRange / insertAfter → 一方事件 + replace surfaceOp；`validateWire` wire 合法性校验 |
| `src/materialize.mjs` | surface → `@@` 围栏纯文本视图 + `diffBlocks`（文本 diff → ops，供 `$EDITOR` 流） |
| `src/channel.mjs` | HTTP 通道：`/spawn /send /seed /sessions /hold /release /run /status /tail /apply /op /ops /events /resume /compact /fork /versions /revert /wire /raw` |
| `src/hold.mjs` | 每会话门控状态机（off/once/sticky + pending gate） |
| `src/events.mjs` | 备选方案：`context/edit` `context/annotate` 投影式实现（未启用，保留作对照） |
| `src/client.js` | DSH Web 客户端模块：右栏注册 `ctx` 标签页，iframe 嵌面板页 |
| `src/ui.html` | 单页上下文编辑器（见下） |
| `bin/dsh-ctx.mjs` | CLI：`spawn / send / seed / sessions / hold / release / run / tail / edit / ops / events / compact / fork`；`edit` 子命令 = materialize → 打开 `$EDITOR` → diff → apply |

## Web 编辑器（ui.html）

把整个会话上下文渲染成一篇可编辑文档（contenteditable）：

- 消息按 surface 节点分块，边距列显示角色；被编辑过的节点标「已改」
- 删除 = 墓碑分割线（`已删除`），不毁尸灭迹
- reasoning / tool-call / tool-result 折叠成原子 chip，点开弹层：reasoning 只读，工具块可编辑 JSON（改 tool-call id 自动同步配对 result）
- 全文查找替换、侧栏版本链（每条 replace 链一节，可一键回退到任意旧版）、事件流与原始日志双视图
- 历史（落盘）会话只读，可一键 `/resume` 接管成 live agent 再编辑
- 工具栏：扣住 / 放行 / 压缩（compactNow）/ 分叉（最近 turn/end 边界 fork 新会话）

## 用法

作为 Cordis 插件挂进 dsh profile（`cordis.yml`）：

```yaml
plugins:
  - name: dsh-transparency
    config:
      port: 4173
```

然后：

```sh
dsh-ctx spawn <session> <provider> <model>   # 起会话
dsh-ctx tail <session>                       # 看当前 wire 上下文（@@ 围栏文本）
dsh-ctx edit <session>                       # 在编辑器里改 → diff → 落库
dsh-ctx hold <session> [--once]              # 扣住下一步
dsh-ctx release <session>                    # 放行
```

或浏览器打开 `http://127.0.0.1:4173/?session=<id>`；DSH GUI 里点右栏 `ctx` 标签。

## 验证

`tests/` 收录了在 dsharness 仓库内跑过的 vitest spike 探针（session surface / agent-loop / applyOps+materialize 全套），见 [tests/README.md](tests/README.md)。

## 定位

这是「Petri —— 面向上下文的 Agent 基础设施」设想的 DSH 内 spike：块级上下文编辑、版本链、hold-and-modify、fork 都先在这个插件里用 harness 原生 `surfaceOp` 机制验证过。生态位对照（SERAC / Anthropic context editing / LangGraph checkpointer 等）见设计文档。

## License

MIT
