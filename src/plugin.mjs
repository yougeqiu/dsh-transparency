import Schema from '@deepseek-ai/schemastery'
import { applyOps } from './apply.mjs'
import { HoldRegistry } from './hold.mjs'
import { startChannel } from './channel.mjs'

export const name = 'dsh-transparency'
export const inject = ['sessions', 'agents', 'agentLoop', 'compaction', 'sessionQuery']

export const Config = Schema.object({
  port: Schema.number().default(4173),
})

export function apply(ctx, config) {
  // 不注册外挂事件投影：context/* 事件会让含它们的日志在重开时被拒
  // （KNOWN_SESSION_EVENT_TYPES 是编译期集，无运行时注册，append 也无法标 ignorable）。
  // 编辑全部走一方事件 + surface replace（见 apply.mjs）。
  const holds = new HoldRegistry()
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
    const gate = holds.gateFor(agent.session.id)
    if (!gate) return next()
    await gate.promise
    return next()
  }))

  const service = { holds, applyOps }
  ctx.provide('transparency', service)
  const channel = startChannel(config.port, ctx, service)
  ctx.effect(() => () => channel.close())
}
