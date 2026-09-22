import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'

/** 'context/edit' { targetSeq, text } —— 替换目标块全部文本块内容 */
export const editProjection = {
  type: 'context/edit',
  project(event, context) {
    const source = context.events[event.data.targetSeq - context.baseSeq]
    if (!source) throw new Error(`context/edit: target seq ${event.data.targetSeq} not in window`)
    const original = deriveEventMessage(source, context.messages)
    if (!original) throw new Error(`context/edit: seq ${event.data.targetSeq} derives no message`)
    if (event.data.text === '') throw new Error('context/edit: empty text forbidden — use delete (empty projection leaks)')
    return new Map([[source.seq, deepFreeze({ ...original, content: [{ type: 'text', text: event.data.text }] })]])
  },
}

/** 'context/annotate' { targetSeq, text } —— 文本追加到目标块尾部（merge-insert 载体） */
export const annotateProjection = {
  type: 'context/annotate',
  project(event, context) {
    const source = context.events[event.data.targetSeq - context.baseSeq]
    if (!source) throw new Error(`context/annotate: target seq ${event.data.targetSeq} not in window`)
    const original = deriveEventMessage(source, context.messages)
    if (!original) throw new Error(`context/annotate: seq ${event.data.targetSeq} derives no message`)
    return new Map([[source.seq, deepFreeze({
      ...original,
      content: [...original.content, { type: 'text', text: event.data.text }],
    })]])
  },
}

export const transparencyProjections = [editProjection, annotateProjection]
