#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.DSH_CTX_PORT ?? 4173
const api = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
}).then(r => r.json())

const [cmd, session, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'spawn':   console.log(await api('/spawn', { session, provider: rest[0], model: rest[1] })); break
  case 'send':    console.log(await api('/send', { session, text: rest.join(' ') })); break
  case 'seed':    console.log(await api('/seed', { session, text: rest.join(' ') })); break
  case 'sessions':console.log(await api('/sessions', {})); break
  case 'status':  console.log(await api('/status', { session })); break
  case 'hold':    console.log(await api('/hold', { session, once: rest.includes('--once') })); break
  case 'release': console.log(await api('/release', { session })); break
  case 'run':     console.log(await api('/run', { session })); break
  case 'tail':    console.log((await api('/tail', { session })).text ?? 'no session'); break
  case 'ops':     console.log(JSON.stringify(await api('/ops', { session }), null, 2)); break
  case 'events':  console.log(JSON.stringify(await api('/events', { session }), null, 2)); break
  case 'compact': console.log(JSON.stringify(await api('/compact', { session }), null, 2)); break
  case 'fork':    console.log(JSON.stringify(await api('/fork', { session, newId: rest[0] }), null, 2)); break
  case 'edit': {
    const { text } = await api('/tail', { session })
    if (!text) { console.log('no session'); break }
    const file = join(mkdtempSync(join(tmpdir(), 'dshctx-')), 'context.txt')
    writeFileSync(file, text)
    spawnSync(process.env.EDITOR ?? 'notepad', [file], { stdio: 'inherit' })
    const edited = readFileSync(file, 'utf8')
    console.log(JSON.stringify(await api('/apply', { session, edited }), null, 2))
    break
  }
  default: console.log('usage: dsh-ctx <spawn|send|sessions|status|hold|release|run|tail|edit|ops> <session> [args]')
}
