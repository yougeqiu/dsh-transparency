# tests

Spike 探针与单测，原生于 [deepseek-harness](https://github.com/deepseek-harness) 仓库（`spike/transparency-probes` 分支）。这些 spec import harness 内部包（`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-agent-loop` 等），需要在一个 dsharness workspace 里用 vitest 跑（`pnpm install` 后 `pnpm vitest run <spec>`）。

| 文件 | 覆盖 |
|---|---|
| `spike-apply.spec.ts` | applyOps 三 op 落地、孤儿 tool-call 拦截、tool-call 改名自动同步 result、遮蔽 seq 吸收态、materialize↔diff 三态 |
| `spike-transparency.spec.ts` | session surface 探针 P2–P5：投影改写、system 头可改、tombstone 语义、projection 置空泄漏（禁用路径）、compaction 遮蔽后的编辑孤儿 |
| `spike-agent-loop.spec.ts` | agent-loop 探针 P1/P6：`agent/pre-step` 挂起放行、`enter` 决策改写 claimed 输入 |
| `mock-adapter.ts` | 从 dsharness `packages/core/agent-loop/tests/` 原样拷贝的 LLM mock adapter |
