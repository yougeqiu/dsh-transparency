import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { materialize, diffBlocks } from './materialize.mjs'

const UI_HTML = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')

async function readJson(req) {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : {}
}

function listContextOps(session) {
  const live = new Set(session.surface.nodes)
  return session.snapshotEvents()
    .filter(e => typeof e.surfaceOp === 'object' && e.surfaceOp?.op === 'replace')
    .map(e => ({ seq: e.seq, type: e.type, targetSeq: e.surfaceOp.startSeq, state: live.has(e.seq) ? 'active' : 'absorbed' }))
}

/** 事件文本提取：user/message 在 data.content，assistant 在 data.message.content，tombstone 为空 */
function eventText(e) {
  const content = e.data?.content ?? e.data?.message?.content ?? []
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}

/** 每条 surface 位置的版本链：从非 replace 根事件出发，沿 startSeq 替换指针走到头。
 *  结构：根 seq → 被 seq4 replace → seq4 又被 seq5 replace → seq5 是当前可见头。 */
function versionChains(session) {
  const live = new Set(session.surface.nodes)
  const all = session.snapshotEvents()
  const replacedBy = new Map()
  for (const e of all) {
    if (e.surfaceOp?.op !== 'replace') continue
    const { startSeq, endSeq } = e.surfaceOp
    // 区间墓碑/区间替换：shadowed = seq ∈ [start..end] 的 surface 类事件（message/tool）
    for (const t of all) {
      if (t.seq >= startSeq && t.seq <= endSeq && (t.type.endsWith('/message') || t.type.startsWith('tool/')))
        replacedBy.set(t.seq, e)
    }
  }
  const chains = []
  for (const e of all) {
    if (e.surfaceOp?.op === 'replace') continue
    const versions = []
    let cur = e
    while (cur) {
      versions.push({
        seq: cur.seq, type: cur.type,
        text: eventText(cur),
        preview: eventText(cur).slice(0, 60),
        state: live.has(cur.seq) ? 'active' : 'absorbed',
      })
      cur = replacedBy.get(cur.seq)
    }
    chains.push({ target: e.seq, versions })
  }
  return chains
}

export function startChannel(port, ctx, svc) {
  const findAgent = id => ctx.agents.get(id) ?? null
  const seen = new Set()
  /** 会话解析：活会话走 agent.session（可写）；落盘会话走 observeSession 只读兜底 */
  const resolve = async id => {
    const agent = findAgent(id)
    if (agent) return { live: true, session: agent.session, agent }
    try {
      const obs = await ctx.get('sessionQuery').observeSession(id)
      const { foldSurface, deriveEventMessage } = await import('@deepseek-ai/dsh-session')
      const folded = foldSurface(obs.events)
      const bySeq = new Map(obs.events.map(e => [e.seq, e]))
      const session = {
        id: obs.header.id,
        surface: { nodes: folded.nodes },
        snapshotEvents: () => obs.events,
        deriveMessages: () => folded.nodes.map(s => deriveEventMessage(bySeq.get(s), folded.projectedMessages)).filter(Boolean),
      }
      return { live: false, session, observed: obs }
    } catch { return { live: false, session: null } }
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(readFileSync(UI_HTML, 'utf8'))
        return
      }
      const body = await readJson(req)
      const resolved = body?.session != null ? await resolve(body.session) : { live: false, session: null }
      const session = resolved.session
      const READONLY = { error: '会话未运行（只读）' }
      let result
      switch (`POST ${new URL(req.url, 'http://x').pathname}`) {
        case 'POST /spawn': {
          // spike 自含演示入口：不�?web UI 也能起真�?agent；provider/model 显式传参
          if (!body.provider || !body.model) { result = { error: 'provider/model required' }; break }
          const { SessionId } = await import('@deepseek-ai/dsh-session')
          const id = SessionId(body.session ?? `spike-${Date.now()}`)
          const agent = await ctx.agentLoop.create(id, {
            provider: body.provider, model: body.model,
            ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
            ...(body.maxTokens ? { maxTokens: body.maxTokens } : {}),
          }, { cwd: body.cwd ?? process.cwd() })
          seen.add(String(agent.session.id))
          result = { session: String(agent.session.id) }
          break
        }
        case 'POST /seed': {
          // spike 调试入口：直接往会话 append user/message（不走回合，无需模型）
          if (!session || !resolved.live) { result = session ? READONLY : { error: 'no session' }; break }
          session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: body.text }],
            source: { kind: 'plugin', plugin: 'dsh-transparency' },
          }), { surfaceOp: 'append' })
          result = { state: 'seeded', nodes: session.surface.nodes.length }
          break
        }
        case 'POST /send': {
          const agent = findAgent(body.session)
          if (!agent) { result = { error: 'no session' }; break }
          agent.followup(createUserMessage({ content: [{ type: 'text', text: body.text }], source: { kind: 'user' } }))
          result = { state: 'sent' }
          break
        }
        case 'POST /sessions': {
          // 活会话 + 落盘会话合并列出（GUI 里开的算活，未打开的算历史）
          const live = ctx.agents.list().map(a => String(a.session.id))
          let persisted = []
          try {
            persisted = (await ctx.get('sessionQuery').listSessions()).map(r => String(r.header?.id ?? r.id))
          } catch { /* sessionQuery 缺失时只列活的 */ }
          result = { sessions: [...new Set([...live, ...persisted])], live }
          break
        }
        case 'POST /hold':    svc.holds.arm(String(body.session), body.once); result = { state: 'armed' }; break
        case 'POST /release': svc.holds.release(String(body.session)); result = { state: 'released' }; break
        case 'POST /run':     svc.holds.disarm(String(body.session)); result = { state: 'off' }; break
        case 'POST /status':  result = { state: svc.holds.state(String(body.session)), pending: svc.holds.pending(String(body.session)) }; break
        case 'POST /tail':    result = session ? { text: materialize(session).text } : { error: 'no session' }; break
        case 'POST /apply': {
          if (!session || !resolved.live) { result = { ok: false, problems: [session ? '会话未运行（只读）' : 'no session'] }; break }
          const { blocks } = materialize(session)
          const ops = diffBlocks(blocks, body.edited)
          result = { ...svc.applyOps(session, ops), ops }
          break
        }
        case 'POST /events': {
          // spike 诊断：全事件类型 + 关键字段（非 surface �?error/attempt 轨迹也可见）
          if (!session) { result = { error: 'no session' }; break }
          const agent = findAgent(body.session)
          result = {
            status: agent?.status,
            events: session.snapshotEvents().map(e => ({ seq: e.seq, type: e.type, summary: JSON.stringify(e.data).slice(0, 120) })),
          }
          break
        }
        case 'POST /resume': {
          // 接管落盘会话 → 官方 resume 口拉成 live agent → 可写
          if (resolved.live) { result = { session: body.session, already: true }; break }
          const { SessionId } = await import('@deepseek-ai/dsh-session')
          const handle = await ctx.agents.resume({
            resumeSessionId: SessionId(body.session),
            agentOptions: { provider: body.provider ?? 'deepseek-official', model: body.model ?? 'deepseek-v4.1-flash' },
          })
          result = { session: String(handle.agent.session.id) }
          break
        }
        case 'POST /compact': {
          const agent = findAgent(body.session)
          const compaction = ctx.compaction
          if (!agent) { result = { error: 'no session' }; break }
          if (!compaction) { result = { error: 'no compaction service' }; break }
          result = { result: await compaction.compactNow(agent, new AbortController().signal) }
          break
        }
        case 'POST /fork': {
          // 取最近一个 turn/end 边界做前缀，经 ctx.agents.create 种成新会话
          const observed = await ctx.sessionQuery.observeSession(body.session)
          const boundary = observed.events.findLast(e => e.type === 'turn/end')
          if (!boundary) { result = { error: 'no completed turn' }; break }
          const cut = boundary.seq + 1
          const { SessionId } = await import('@deepseek-ai/dsh-session')
          const childId = SessionId(body.newId ?? `${body.session}-fork-${Date.now()}`)
          await ctx.agents.create({
            sessionId: childId,
            seed: observed.events.slice(0, cut),
            inheritedEventCount: cut,
            meta: { parentSession: observed.header.id, isSeeded: true, ...(observed.header.cwd === undefined ? {} : { cwd: observed.header.cwd }) },
            agentOptions: { provider: body.provider ?? 'deepseek-official', model: body.model ?? 'deepseek-v4.1-flash' },
          })
          seen.add(String(childId))
          result = { session: String(childId), atSeq: boundary.seq }
          break
        }
        case 'POST /op': {
          // 卡片级单操作：模型端编辑/删除/插入直接落
          if (!session || !resolved.live) { result = { ok: false, problems: [session ? '会话未运行（只读）' : 'no session'] }; break }
          result = svc.applyOps(session, [body.op])
          break
        }
        case 'POST /ops': {
          // 批量操作：一次 applyOps → 一次 wire 校验（批量删/批量改/跨块区间删）
          if (!session || !resolved.live) { result = { ok: false, problems: [session ? '会话未运行（只读）' : 'no session'] }; break }
          result = svc.applyOps(session, body.ops ?? [])
          break
        }
        case 'POST /versions': {
          if (!session) { result = { error: 'no session' }; break }
          result = { chains: versionChains(session) }
          break
        }
        case 'POST /revert': {
          // git revert 语义：取目标节点某版本文本，append 一条同内容新 replace（链尾换头）
          if (!session) { result = { error: 'no session' }; break }
          const target = Number(body.target)
          const chain = versionChains(session).find(c => c.target === target)
          const version = chain?.versions.find(v => v.seq === Number(body.seq))
          const head = chain?.versions.find(v => v.state === 'active')
          if (!chain || !version || !head) { result = { error: 'no such version' }; break }
          // 幂等：目标版本文本与当前头相同 → no-op，不增殖 replace
          if (version.text === head.text) { result = { skipped: '已是当前内容' }; break }
          const r = svc.applyOps(session, [{ kind: 'edit', seq: head.seq, text: version.text }])
          result = { ...r, revertedTo: Number(body.seq) }
          break
        }
        case 'POST /wire': {
          // 模型视图：surface 节点级输出（seq 定位 + role + content），编辑直接作用在模型可见面上
          if (!session) { result = { error: 'no session' }; break }
          const events = new Map(session.snapshotEvents().map(e => [e.seq, e]))
          result = {
            live: resolved.live,
            nodes: session.surface.nodes.map(seq => {
              const e = events.get(seq)
              const content = e?.data?.content ?? e?.data?.message?.content ?? []
              const role = e?.data?.role ?? e?.data?.message?.role ?? 'unknown'
              return { seq, role, content, tombstoned: content.length === 0 }
            }),
          }
          break
        }
        case 'POST /raw': {
          // 原始视图：日志事件原文（seq/type/data 全量），只读
          if (!session) { result = { error: 'no session' }; break }
          result = { events: session.snapshotEvents().map(e => ({ seq: e.seq, type: e.type, surfaceOp: e.surfaceOp, sourceEventSeqs: e.sourceEventSeqs, data: e.data })) }
          break
        }
        case 'POST /graph': {
          const cm = ctx.get('clientModules')
          result = cm ? { path: cm.clientPath('dsh-transparency'), row: cm.graph().entries.find(e => e.id === 'dsh-transparency'), batches: cm.graph().batches.filter(b => b.entries.includes('dsh-transparency')) } : { error: 'no clientModules' }
          break
        }
        case 'POST /ops': result = { ops: session ? listContextOps(session) : [] }; break
        default: result = { error: `no route ${req.method} ${req.url}` }
      }
      res.end(JSON.stringify(result))
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) })) }
  })
  server.listen(port, '127.0.0.1')
  return server
}
