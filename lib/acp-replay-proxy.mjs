#!/usr/bin/env node
/**
 * Transparent ACP stdio proxy for `dsh --profile acp`.
 *
 * Bridges protocol gaps between upstream DSH ACP and T3 Code's native ACP
 * session management:
 * 1. Advertises `agentCapabilities.loadSession = true` on `initialize`.
 * 2. Enriches `session/list` with `title` and `updatedAt` read from DSH's
 *    `session.v4.jsonl.zstd` logs, sorted newest-first, hiding 0-turn probes.
 * 3. Translates `session/load` into `session/resume` while replaying historical
 *    user/assistant messages as standard ACP `session/update` notifications so
 *    T3 Code renders full native conversation bubbles.
 * 4. Filters unconfigured `deepseek-official` placeholder entries when another
 *    configured provider (such as `deepseek-account`) is present, avoiding
 *    model-selection errors on native session import.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0)
})

const HOME = process.env.HOME || '/root'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const T3_HOME = process.env.T3CODE_HOME || path.join(HOME, '.t3')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const DSH_BIN = process.env.DSH_BIN || '/usr/local/bin/dsh'

const metaCache = new Map()

function findSessionFile(sessionId) {
  if (!sessionId || !fs.existsSync(SESSIONS_ROOT)) return null
  for (const wsEntry of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!wsEntry.isDirectory() || wsEntry.name.startsWith('.')) continue
    const sDir = path.join(SESSIONS_ROOT, wsEntry.name, sessionId)
    if (!fs.existsSync(sDir)) continue
    const zstdPath = path.join(sDir, 'session.v4.jsonl.zstd')
    if (fs.existsSync(zstdPath)) return zstdPath
    const jsonlPath = path.join(sDir, 'session.v4.jsonl')
    if (fs.existsSync(jsonlPath)) return jsonlPath
  }
  return null
}

function readEvents(filePath) {
  const raw = fs.readFileSync(filePath)
  const text = filePath.endsWith('.zstd')
    ? zlib.zstdDecompressSync(raw).toString('utf8')
    : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // Ignore incomplete trailing line
    }
  }
  return events
}

function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push(part.text)
    }
  }
  return parts.join('\n').trim()
}

function isRealUserMessage(ev) {
  if (ev.type !== 'user/message') return false
  if (ev.data?.source?.kind && ev.data.source.kind !== 'user') return false
  const t = extractText(ev.data?.content)
  if (!t || t.startsWith('Time sampled while preparing')) return false
  return true
}

function cleanUserPreview(raw) {
  let text = String(raw || '')
  const reqMatch = text.match(/<user_request>\s*([\s\S]*?)(?:<\/user_request>|$)/)
  if (reqMatch) text = reqMatch[1].trim()
  return text.replace(/\s+/g, ' ').slice(0, 80)
}

function getSessionMeta(sessionId) {
  const filePath = findSessionFile(sessionId)
  if (!filePath) return null
  const stat = fs.statSync(filePath)
  const cached = metaCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.meta

  let title = ''
  let firstUser = ''
  let userCount = 0
  let cwd = null
  try {
    const events = readEvents(filePath)
    for (const ev of events) {
      if (ev.type === 'session' && ev.cwd) {
        cwd = ev.cwd
      } else if (ev.type === 'session/title' && ev.data?.title) {
        const cand = String(ev.data.title).trim()
        if (cand && !cand.startsWith('<t3_code_instructions>')) title = cand
      } else if (isRealUserMessage(ev)) {
        userCount++
        if (!firstUser) firstUser = cleanUserPreview(extractText(ev.data?.content))
      }
    }
  } catch {
    // Fallback to stat-only metadata
  }

  const meta = {
    title: title || firstUser || null,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    userCount,
    cwd,
  }
  metaCache.set(filePath, { mtimeMs: stat.mtimeMs, meta })
  return meta
}

function extractReplayMessages(sessionId) {
  const filePath = findSessionFile(sessionId)
  if (!filePath) return []
  let events
  try {
    events = readEvents(filePath)
  } catch {
    return []
  }

  const messages = []
  let pendingAssistantTexts = []
  let pendingAssistantId = null

  const flushAssistant = () => {
    if (pendingAssistantTexts.length > 0) {
      messages.push({
        kind: 'agent_message_chunk',
        messageId: pendingAssistantId,
        text: pendingAssistantTexts.join('\n\n'),
      })
      pendingAssistantTexts = []
      pendingAssistantId = null
    }
  }

  for (const ev of events) {
    if (isRealUserMessage(ev)) {
      flushAssistant()
      messages.push({
        kind: 'user_message_chunk',
        messageId: `dsh-hist-u-${ev.seq ?? messages.length}`,
        text: extractText(ev.data?.content),
      })
    } else if (ev.type === 'assistant/message') {
      const text = extractText(ev.data?.message?.content)
      if (text) {
        if (!pendingAssistantId) pendingAssistantId = `dsh-hist-a-${ev.seq ?? messages.length}`
        pendingAssistantTexts.push(text)
      }
    } else if (ev.type === 'turn/end') {
      flushAssistant()
    }
  }
  flushAssistant()
  return messages
}

function pickFallbackModel(options) {
  if (!Array.isArray(options)) return null
  for (const group of options) {
    if (!group || group.group === 'deepseek-official') continue
    if (Array.isArray(group.options) && group.options.length > 0 && group.options[0]?.value) {
      return group.options[0].value
    }
  }
  return null
}

let preferredFallbackModel = JSON.stringify(['deepseek-account', 'deepseek-flash'])

function sanitizeConfigOptions(result) {
  if (!result || !Array.isArray(result.configOptions)) return result
  for (const opt of result.configOptions) {
    if (opt && opt.id === 'model' && Array.isArray(opt.options)) {
      const fallback = pickFallbackModel(opt.options)
      if (fallback) {
        preferredFallbackModel = fallback
        opt.options = opt.options.filter((g) => !(g && g.group === 'deepseek-official'))
        if (typeof opt.currentValue === 'string' && opt.currentValue.includes('deepseek-official')) {
          opt.currentValue = fallback
        }
      }
    }
  }
  return result
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const dshArgs = ['--profile', 'acp']
const candidatePatches = [
  '/opt/dsh-app/auth/auth.patch.yml',
  '/opt/dsh-app/phone/phone.patch.yml',
  path.join(T3_HOME, 'dsh-sessions-mcp.patch.yml'),
]
for (const patchPath of candidatePatches) {
  if (fs.existsSync(patchPath)) dshArgs.push('--patch', patchPath)
}

const child = spawn(DSH_BIN, dshArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try { child.kill(sig) } catch {}
  })
}

const pending = new Map()

const inRl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
inRl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    child.stdin.write(line + '\n')
    return
  }

  if (msg.method === 'initialize' && msg.id !== undefined) {
    pending.set(String(msg.id), { type: 'initialize' })
    child.stdin.write(line + '\n')
  } else if (msg.method === 'session/list' && msg.id !== undefined) {
    pending.set(String(msg.id), { type: 'session/list' })
    child.stdin.write(line + '\n')
  } else if (msg.method === 'session/new' && msg.id !== undefined) {
    pending.set(String(msg.id), { type: 'session/new' })
    child.stdin.write(line + '\n')
  } else if (
    msg.method === 'session/set_config_option' &&
    msg.params?.configId === 'model' &&
    typeof msg.params?.value === 'string' &&
    msg.params.value.includes('deepseek-official')
  ) {
    const fixed = { ...msg, params: { ...msg.params, value: preferredFallbackModel } }
    child.stdin.write(JSON.stringify(fixed) + '\n')
  } else if (
    msg.method === 'session/set_model' &&
    typeof msg.params?.modelId === 'string' &&
    msg.params.modelId.includes('deepseek-official')
  ) {
    const fixed = { ...msg, params: { ...msg.params, modelId: preferredFallbackModel } }
    child.stdin.write(JSON.stringify(fixed) + '\n')
  } else if (msg.method === 'session/load' && msg.id !== undefined) {
    const sessionId = msg.params?.sessionId
    pending.set(String(msg.id), { type: 'session/load', sessionId })
    const rewritten = { ...msg, method: 'session/resume' }
    child.stdin.write(JSON.stringify(rewritten) + '\n')
  } else {
    child.stdin.write(line + '\n')
  }
})

inRl.on('close', () => {
  try { child.stdin.end() } catch {}
})

const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
outRl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    process.stdout.write(line + '\n')
    return
  }

  const key = msg.id !== undefined && msg.id !== null ? String(msg.id) : null
  const req = key !== null ? pending.get(key) : null
  if (req) pending.delete(key)

  if (req?.type === 'initialize' && msg.result) {
    const caps = msg.result.agentCapabilities || {}
    msg.result.agentCapabilities = { ...caps, loadSession: true }
    writeOut(msg)
    return
  }

  if (req?.type === 'session/list' && msg.result && Array.isArray(msg.result.sessions)) {
    const enriched = []
    for (const s of msg.result.sessions) {
      const meta = getSessionMeta(s.sessionId)
      if (meta && meta.userCount === 0) continue
      enriched.push({
        ...s,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta?.updatedAt ? { updatedAt: meta.updatedAt } : {}),
        _mtime: meta?.mtimeMs || 0,
      })
    }
    enriched.sort((a, b) => b._mtime - a._mtime)
    msg.result.sessions = enriched.map(({ _mtime, ...rest }) => rest)
    writeOut(msg)
    return
  }

  if (req?.type === 'session/new' && msg.result && !msg.error) {
    sanitizeConfigOptions(msg.result)
    writeOut(msg)
    return
  }

  if (req?.type === 'session/load' && msg.result && !msg.error) {
    sanitizeConfigOptions(msg.result)
    const history = extractReplayMessages(req.sessionId)
    for (const item of history) {
      writeOut({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: req.sessionId,
          update: {
            sessionUpdate: item.kind,
            messageId: item.messageId,
            content: { type: 'text', text: item.text },
          },
        },
      })
    }
    writeOut(msg)
    return
  }

  process.stdout.write(line + '\n')
})
