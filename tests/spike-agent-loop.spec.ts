import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('spike transparency — agent-loop probes', () => {
  it('P1: agent/pre-step listener 无限期挂起 + 外部信号放行，请求被扣住后可放行', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('p1'), { provider: 'mock', model: 'mock' })

    const gate = Promise.withResolvers<void>()
    ctx.on('agent/pre-step', async (_payload, next) => { await gate.promise; return next() })

    send(agent, 'held')
    await new Promise(r => setTimeout(r, 150))
    expect(adapter.requests).toHaveLength(0)

    gate.resolve()
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('P6: enter 决策改写 claimed 输入，wire 与日志均为改后内容', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('p6'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async ({ messages }): Promise<PreStepDecision> =>
      ({ kind: 'enter', messages: [{ ...messages[0]!, content: [{ type: 'text', text: 'REWRITTEN' }] }] }))

    send(agent, 'original')
    await waitForIdle(ctx, agent)

    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('REWRITTEN')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('original')
    const logged = agent.session.snapshotEvents().find((e: SessionEvent) => e.type === 'user/message')
    expect(JSON.stringify(logged?.data)).toContain('REWRITTEN')
  })
})
