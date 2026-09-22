import { describe, expect, it } from 'vitest'
import {
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  Session,
  SessionId,
  SessionSeq,
  SessionLogOffset,
  deriveEventMessage,
  foldSurface,
} from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'context/edit': { targetSeq: SessionSeq; text: string }
  }
}

/** 把 targetSeq 指向的消息内容改成 text；text === '' 时投影成空内容（P3b 探针用）。 */
const editProjection: SessionMessageProjection<'context/edit'> = {
  type: 'context/edit',
  project(event, context) {
    const source = context.events[event.data.targetSeq - context.baseSeq]!
    const original = deriveEventMessage(source, context.messages)!
    const content = event.data.text === ''
      ? []
      : [{ type: 'text' as const, text: event.data.text }]
    return new Map([[source.seq, deepFreeze({ ...original, content })]])
  },
}

const defs = [editProjection]

function session(id: string) {
  return Session.create(SessionId(id), undefined, undefined, undefined, defs)
}

function userMsg(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function sysMsg(text: string) {
  return { turn: 1, step: 1, message: createSystemMessage(text, 'p') }
}

const texts = (s: Session) => s.deriveMessages().flatMap(m => m.content.map(b => ('text' in b ? b.text : '')))

describe('spike transparency — session surface probes', () => {
  it('P2: context/edit 投影事件改写 deriveMessages 且原块不动', () => {
    const s = session('p2')
    const victim = s.append('user/message', userMsg('original'), { surfaceOp: 'append' })
    s.append('context/edit', { targetSeq: victim.seq, text: 'edited' })
    expect(texts(s)).toEqual(['edited'])
    expect(victim.data.content).toEqual([{ type: 'text', text: 'original' }])
    const folded = foldSurface(s.snapshotEvents(), defs)
    expect(deriveEventMessage(victim, folded.projectedMessages)?.content).toEqual([{ type: 'text', text: 'edited' }])
    expect(s.surface.replaceGeneration).toBe(0)
    expect(s.surface.contentGeneration).toBe(1)
  })

  it('P5: 投影可改写 node 0 的 system 提示（projection 不走 head 保护）', () => {
    const s = session('p5')
    const head = s.append('system/message', sysMsg('be brief'), { surfaceOp: 'append' })
    s.append('user/message', userMsg('hi'), { surfaceOp: 'append' })
    s.append('context/edit', { targetSeq: head.seq, text: 'be verbose' })
    expect(s.deriveMessages()[0]?.role).toBe('system')
    expect(texts(s)[0]).toBe('be verbose')
  })

  it('P3a: 空 system/message replace = tombstone，wire 无此消息、节点保留', () => {
    const s = session('p3a')
    s.append('system/message', sysMsg('sys'), { surfaceOp: 'append' })
    const victim = s.append('user/message', userMsg('victim'), { surfaceOp: 'append' })
    s.append('user/message', userMsg('keep'), { surfaceOp: 'append' })
    const tomb = s.append('system/message', sysMsg(''), {
      surfaceOp: { op: 'replace', startSeq: victim.seq, endSeq: victim.seq },
      sourceEventSeqs: [victim.seq],
    })
    expect(texts(s)).toEqual(['sys', 'keep'])
    expect(s.surface.nodes).toEqual([0, tomb.seq, 2])
    expect(s.surface.replaceGeneration).toBe(1)
  })

  it('P3b: projection 置空 = 空消息泄漏上 wire（该路径禁用，非删除）', () => {
    const s = session('p3b')
    const victim = s.append('user/message', userMsg('victim'), { surfaceOp: 'append' })
    s.append('context/edit', { targetSeq: victim.seq, text: '' })
    const messages = s.deriveMessages()
    // 预期泄漏而非删除：projection 值被原样放行，deriveEventMessage 不会滤掉它
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toEqual([])
  })

  it('P3c: tombstone tool_result 后孤儿 tool-call 裸上 wire（插件校验器负责拦）', () => {
    const s = session('p3c')
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
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    s.append('system/message', sysMsg(''), {
      surfaceOp: { op: 'replace', startSeq: tr.seq, endSeq: tr.seq },
      sourceEventSeqs: [tr.seq],
    })
    expect(s.deriveMessages().map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('P4: compaction 式遮蔽后，指向被遮蔽 seq 的编辑事件不抛、不改 wire', () => {
    const s = session('p4')
    const a = s.append('user/message', userMsg('a'), { surfaceOp: 'append' })
    const b = s.append('user/message', userMsg('b'), { surfaceOp: 'append' })
    s.append('context/edit', { targetSeq: b.seq, text: 'edited b' })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary of a+b' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: a.seq, endSeq: b.seq },
      sourceEventSeqs: [a.seq, b.seq],
    })
    expect(texts(s)).toEqual(['summary of a+b'])
    // 编辑指向已遮蔽的 seq —— 预期静默成孤儿条目（不抛、不上 wire）；若抛异常则记 FAIL
    s.append('context/edit', { targetSeq: a.seq, text: 'edited a' })
    expect(texts(s)).toEqual(['summary of a+b'])
  })
})
