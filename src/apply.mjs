import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'

/**
 * ops: { kind: 'edit'|'annotate'|'delete'|'insertAfter', seq, text? }
 * 全部落成 append-only 一方事件（user/system/assistant message + replace surfaceOp），
 * 不引入外挂事件类型 —— 含本插件事件的日志对任意 harness 可重开（无 ignorable 依赖）。
 * insertAfter = merge 语义，并入 seq 对应块。应用后用 deriveMessages 投影结果跑 wire 校验。
 */
export function applyOps(session, ops, defs = []) {
  const surfaceSeqs = new Set(session.surface.nodes)
  const events = new Map(session.snapshotEvents().map(e => [e.seq, e]))
  const folded = foldSurface(events, defs)
  const applied = []
  const problems = []

  const replace = (type, data, seq, endSeq = seq) => {
    // sourceEventSeqs 必须列全 [start..end] 内被遮蔽的 surface 节点（含非首尾）
    const startIdx = session.surface.nodes.indexOf(seq)
    const endIdx = session.surface.nodes.indexOf(endSeq)
    const shadowed = startIdx !== -1 && endIdx !== -1
      ? session.surface.nodes.slice(startIdx, endIdx + 1)
      : [seq]
    const ev = session.append(type, data, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq },
      // assistant/message 内嵌自身 stream 溯源，拒绝 sourceEventSeqs；replace 链接靠 surfaceOp.startSeq
      ...(type === 'assistant/message' ? {} : { sourceEventSeqs: shadowed }),
    })
    events.set(ev.seq, ev)  // 批内新事件补进表：后续 op 的删除预检要能 derive 到它
    return ev
  }

  const tombstone = () => ({
    turn: 0, step: 0,
    message: { role: 'system', content: [], source: { kind: 'plugin', plugin: 'dsh-transparency' } },
  })

  // sim = 当前 wire 投影的工作副本；每个 op（含自动同步的配对 op）先在副本上预演，
  // 整批 validateWire 过了才落真实事件。
  let sim = session.surface.nodes
    .map(seq => ({ seq, msg: deriveEventMessage(events.get(seq), folded.projectedMessages) }))
    .filter(x => x.msg)

  // text 编辑只替换文本块、保留非文本块（reasoning/tool-call/tool-result 不陪葬）；
  // content 整块替换用于块级编辑（chip JSON）。
  const newContentOf = (msg, op) => op.kind === 'edit'
    ? (op.content ?? [{ type: 'text', text: op.text }, ...msg.content.filter(b => b.type !== 'text')])
    : [...msg.content, { type: 'text', text: op.text }]

  /** 单 op 作用于 wire 副本；不可作用（seq 不在面/区间非法）返回 null */
  const toSim = (list, op) => {
    if (op.kind === 'deleteRange') {
      const a = session.surface.nodes.indexOf(op.start), b = session.surface.nodes.indexOf(op.end)
      if (a === -1 || b === -1 || a > b) return null
      const span = new Set(session.surface.nodes.slice(a, b + 1))
      return list.filter(x => !span.has(x.seq))
    }
    const idx = list.findIndex(x => x.seq === op.seq)
    if (idx === -1) return null
    if (op.kind === 'delete') return list.filter(x => x.seq !== op.seq)
    return list.map((x, i) => i === idx ? { seq: op.seq, msg: { ...x.msg, content: newContentOf(x.msg, op) } } : x)
  }

  /** edit 触发 tool-call id 改名时，生成配对 result 的同步 edit op（removed/new 按位置配对） */
  const syncOps = (op) => {
    if (op.kind !== 'edit' || !op.content) return []
    const idx = sim.findIndex(x => x.seq === op.seq)
    if (idx === -1) return []
    const oldIds = sim[idx].msg.content.filter(b => b.type === 'tool-call').map(b => b.id)
    const newIds = op.content.filter(b => b.type === 'tool-call').map(b => b.id)
    const removedIds = oldIds.filter(id => !newIds.includes(id))
    const addedIds = newIds.filter(id => !oldIds.includes(id))
    const out = []
    removedIds.forEach((removed, k) => {
      const renamedTo = addedIds[k]
      if (!renamedTo) return
      const holder = sim.find(x => x.msg.content.some(b => b.type === 'tool-result' && b.toolCallId === removed))
      if (holder) out.push({ kind: 'edit', seq: holder.seq, content: holder.msg.content.map(b =>
        b.type === 'tool-result' && b.toolCallId === removed ? { ...b, toolCallId: renamedTo } : b) })
    })
    return out
  }

  /** 预演通过后落真实事件（edit/annotate/insertAfter/delete/deleteRange） */
  const toEvent = (op) => {
    if (op.kind === 'deleteRange') return replace('system/message', tombstone(), op.start, op.end)
    if (op.kind === 'delete') return replace('system/message', tombstone(), op.seq)
    const src = events.get(op.seq)
    const msg = sim.find(x => x.seq === op.seq).msg
    const content = newContentOf(msg, op)
    switch (src.type) {
      case 'user/message':
        return replace('user/message', { ...src.data, content }, op.seq)
      case 'system/message':
        return replace('system/message', { ...src.data, message: { ...src.data.message, content } }, op.seq)
      default:
        // assistant/tool-result/其他类型 → system/message 承载完整克隆消息：
        // role、toolCallId、isError 等全保留；deriveEventMessage 原样投影。
        return replace('system/message', {
          turn: src.data.turn ?? 0, step: src.data.step ?? 0,
          message: { ...msg, content, source: { kind: 'plugin', plugin: 'dsh-transparency' } },
        }, op.seq)
    }
  }

  for (const op of ops) {
    // 主 op + 自动同步 op 合成一批，一起预演一起落（tool-call 改名不断对）
    const batch = [op, ...syncOps(op)]
    let next = sim
    for (const b of batch) { next = toSim(next ?? [], b) ?? null; if (!next) break }
    if (!next) { applied.push({ op, state: 'absorbed' }); continue }
    const errs = validateWire(next.map(x => x.msg))
    if (errs.length) {
      problems.push(...errs.map(p => `seq=${op.seq ?? `${op.start}..${op.end}`}: ${p}`))
      applied.push({ op, state: 'rejected' }); continue
    }
    for (const b of batch) toEvent(b)
    sim = next
    applied.push({ op, state: 'active', ...(batch.length > 1 ? { synced: batch.length - 1 } : {}) })
  }
  problems.push(...validateWire(session.deriveMessages()))
  return { applied, problems, ok: problems.length === 0 }
}

/** wire 合法性：删完 tool_result 不得留孤儿 tool-call；不得有空内容消息（P3b 泄漏守卫）。 */
export function validateWire(messages) {
  const problems = []
  messages.forEach((m, i) => {
    if (m.content.length === 0) problems.push(`empty ${m.role} message at wire index ${i}`)
    for (const b of m.content) {
      if (b.type === 'tool-call') {
        const next = messages[i + 1]
        const paired = next?.content.some(c => c.type === 'tool-result' && c.toolCallId === b.id)
        if (!paired) problems.push(`orphan tool-call ${b.id} at wire index ${i}`)
      }
      if (b.type === 'tool-result') {
        const prev = messages[i - 1]
        const paired = prev?.content.some(c => c.type === 'tool-call' && c.id === b.toolCallId)
        if (!paired) problems.push(`orphan tool-result ${b.toolCallId} at wire index ${i}`)
      }
    }
  })
  return problems
}
