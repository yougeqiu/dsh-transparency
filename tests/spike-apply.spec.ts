import { describe, expect, it } from 'vitest'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session'
// @ts-expect-error 插件源为 .mjs，无类型声明
import { applyOps, validateWire } from '../src/apply.mjs'
// @ts-expect-error
import { transparencyProjections } from '../src/events.mjs'
// @ts-expect-error
import { materialize, diffBlocks } from '../src/materialize.mjs'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'context/edit': { targetSeq: SessionSeq; text: string }
    'context/annotate': { targetSeq: SessionSeq; text: string }
  }
}

const defs = transparencyProjections as SessionMessageProjection[]
function session(id: string) { return Session.create(SessionId(id), undefined, undefined, undefined, defs) }
function userMsg(text: string) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
const texts = (s: Session) => s.deriveMessages().flatMap(m => m.content.map(b => ('text' in b ? b.text : '')))

describe('spike applyOps', () => {
  it('edit / annotate / delete 三 op 落地', () => {
    const s = session('apply1')
    const a = s.append('user/message', userMsg('A'), { surfaceOp: 'append' })
    const b = s.append('user/message', userMsg('B'), { surfaceOp: 'append' })
    const c = s.append('user/message', userMsg('C'), { surfaceOp: 'append' })
    const r = applyOps(s, [
      { kind: 'edit', seq: a.seq, text: 'A-edited' },
      { kind: 'annotate', seq: b.seq, text: '+note' },
      { kind: 'delete', seq: c.seq },
    ])
    expect(r.ok).toBe(true)
    expect(texts(s)).toEqual(['A-edited', 'B', '+note'])
  })

  it('删除 tool_result 孤儿化 tool-call → 校验器报 orphan', () => {
    const s = session('apply2')
    s.append('user/message', userMsg('q'), { surfaceOp: 'append' })
    s.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    const tr = s.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    const r = applyOps(s, [{ kind: 'delete', seq: tr.seq }])
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/orphan tool-call/)
  })

  it('编辑 tool-result 文本 + 改 tool-call id 自动同步配对', () => {
    const s = session('tool1')
    s.append('user/message', userMsg('q'), { surfaceOp: 'append' })
    const call = s.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    const res = s.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })

    // 1) 改 result 文本（配对不变）
    const r1 = applyOps(s, [{ kind: 'edit', seq: res.seq, text: 'edited result' }])
    expect(r1.ok).toBe(true)
    expect(texts(s)).toContain('edited result')

    // 2) 改 call 的 id → 自动同步 result 的 toolCallId
    const callContent = s.deriveMessages().flatMap(m => m.content).find(b => b.type === 'tool-call')
    const newContent = [{ ...callContent!, id: 'c9' }]
    const r2 = applyOps(s, [{ kind: 'edit', seq: call.seq, content: newContent }])
    expect(r2.ok).toBe(true)
    const wire = s.deriveMessages()
    const resBlock = wire.flatMap(m => m.content).find(b => b.type === 'tool-result')
    expect((resBlock as { toolCallId: string }).toolCallId).toBe('c9')
  })

  it('遮蔽 seq 上的 op 标 absorbed 不 append', () => {
    const s = session('apply3')
    const a = s.append('user/message', userMsg('a'), { surfaceOp: 'append' })
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'sum' }], source: { kind: 'plugin', plugin: 'x' } }), {
      surfaceOp: { op: 'replace', startSeq: a.seq, endSeq: a.seq }, sourceEventSeqs: [a.seq],
    })
    const r = applyOps(s, [{ kind: 'edit', seq: a.seq, text: 'x' }])
    expect(r.applied[0]!.state).toBe('absorbed')
    expect(texts(s)).toEqual(['sum'])
  })

  it('materialize → diff 三态：无改/edit/delete/insert', () => {
    const s = session('mat1')
    s.append('user/message', userMsg('hello'), { surfaceOp: 'append' })
    const { text, blocks } = materialize(s, defs)
    expect(text).toContain('seq=0')
    expect(diffBlocks(blocks, text)).toEqual([])
    expect(diffBlocks(blocks, text.replace('hello', 'world'))).toEqual([{ kind: 'edit', seq: 0, text: 'world' }])
    expect(diffBlocks(blocks, text.replace(/@@ 用户 seq=0[\s\S]*$/, ''))).toEqual([{ kind: 'delete', seq: 0 }])
    expect(diffBlocks(blocks, text + '@@ insert\nbrand new\n')).toEqual([{ kind: 'insertAfter', seq: 0, text: 'brand new' }])
  })
})
