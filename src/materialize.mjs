import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'

const FENCE = '@@'
const ROLE_CN = { user: '用户', assistant: '助手', system: '系统', tool: '工具' }
/** 非文本块折叠标记：渲染进可编辑文本，提交时剥离（编辑 = 纯文本替换，原 reasoning 不随编辑保留） */
export const FOLD_MARK = (b) => b.type === 'reasoning' ? '⟨思考已隐藏⟩' : `⟨${b.type}已隐藏⟩`

/**
 * surface → @@ 文本 + 块索引。defs 由插件持有并显式传入（Session 不暴露投影定义）。
 * 返回 { text, blocks: Map<seq, {tombstoned, text}> }，diff 用 blocks 做原文对照。
 */
export function materialize(session, defs = []) {
  const events = session.snapshotEvents()
  const folded = foldSurface(events, defs)
  const blocks = new Map()
  const out = [`# dsh-ctx · session ${session.id} · ${session.surface.nodes.length} nodes`, `# fence: ${FENCE}`, '']
  for (const seq of session.surface.nodes) {
    const msg = deriveEventMessage(events[seq], folded.projectedMessages)
    if (!msg) {
      blocks.set(seq, { tombstoned: true, text: '' })
      out.push(`${FENCE} node seq=${seq} [tombstoned]`, '')
      continue
    }
    // 产出事件带 replace surfaceOp → 该节点是被编辑替换过的（patched 语义等价）
    const patched = typeof events[seq].surfaceOp === 'object' ? ' patched' : ''
    out.push(`${FENCE} ${ROLE_CN[msg.role] ?? msg.role} seq=${seq}${patched}`)
    const text = msg.content.map(b => b.type === 'text' ? b.text : FOLD_MARK(b)).join('\n')
    blocks.set(seq, { tombstoned: false, text })
    out.push(text, '')
  }
  return { text: out.join('\n'), blocks }
}

/** 解析 @@ 文本为有序块 [{seq|null, tombstoned, text}]。seq=null 表示用户新起的 insert 块。 */
export function parseBlocks(text) {
  const blocks = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue
    const h = line.match(/^@@ (\S+)(?: seq=(\d+))?/)
    if (h) {
      cur = { seq: h[2] != null ? Number(h[2]) : null, tombstoned: line.includes('[tombstoned]'), lines: [] }
      blocks.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
  }
  for (const b of blocks) b.text = b.lines.join('\n').replace(/\n+$/, '')
  return blocks
}

/**
 * 原件 blocks 对照编辑后文本 → ops。
 * seq 头没了 → delete；正文变 → edit；无 seq 新块 → insertAfter 并入上一个 seq；
 * tombstoned 块维持死亡；含 @@raw 的块改动被跳过（spike 不编辑非文本块）。
 */
export function diffBlocks(original, editedText) {
  const ops = []
  const seen = new Set()
  let prevSeq = null
  for (const b of parseBlocks(editedText)) {
    if (b.seq == null) {
      if (b.text.trim()) ops.push({ kind: 'insertAfter', seq: prevSeq, text: b.text.trim() })
      continue
    }
    seen.add(b.seq)
    prevSeq = b.seq
    if (b.tombstoned) continue
    const orig = original.get(b.seq)
    if (orig && !orig.tombstoned && !orig.text.includes(`${FENCE}raw`) && b.text !== orig.text) {
      // 剥离折叠标记行：编辑是纯文本替换，标记不是内容
      const stripped = b.text.split('\n').filter(l => !l.startsWith('⟨')).join('\n').replace(/\n+$/, '')
      ops.push({ kind: 'edit', seq: b.seq, text: stripped })
    }
  }
  for (const [seq, orig] of original) {
    if (!seen.has(seq) && !orig.tombstoned) ops.push({ kind: 'delete', seq })
  }
  return ops
}
