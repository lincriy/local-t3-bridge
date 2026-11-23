#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server exposing DSH Go chat sessions to agents
 * running under T3 Code (including cross-device Linked Environments).
 *
 * Tools:
 * - list_dsh_sessions: list recent DSH Go sessions with title, cwd, turns, preview
 * - read_dsh_session: decompress and read a session transcript (or "latest")
 * - resume_dsh_session: continue an existing DSH Go session in-place via headless mode
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
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const DSH_BIN = process.env.DSH_BIN || '/usr/local/bin/dsh'

function readSessionLines(filePath) {
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
      // Ignore partial trailing line
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
    if (part.type === 'text' && typeof part.text === 'string') {
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

function discoverSessions() {
  const results = []
  if (!fs.existsSync(SESSIONS_ROOT)) return results
  for (const wsEntry of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!wsEntry.isDirectory() || wsEntry.name.startsWith('.')) continue
    const wsDir = path.join(SESSIONS_ROOT, wsEntry.name)
    for (const sEntry of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sEntry.isDirectory() || !sEntry.name.startsWith('session-')) continue
      const sDir = path.join(wsDir, sEntry.name)
      const zstdPath = path.join(sDir, 'session.v4.jsonl.zstd')
      const jsonlPath = path.join(sDir, 'session.v4.jsonl')
      const filePath = fs.existsSync(zstdPath)
        ? zstdPath
        : fs.existsSync(jsonlPath)
          ? jsonlPath
          : null
      if (!filePath) continue
      const stat = fs.statSync(filePath)
      results.push({
        sessionId: sEntry.name,
        workspaceDir: wsEntry.name,
        filePath,
        updatedAtMs: stat.mtimeMs,
        sizeBytes: stat.size,
      })
    }
  }
  results.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  return results
}

function summarizeSession(entry) {
  const events = readSessionLines(entry.filePath)
  let title = ''
  let cwd = path.join(HOME, 'workspace')
  let createdAt = null
  let turns = 0
  const userTexts = []
  let lastAssistant = ''

  for (const ev of events) {
    if (ev.type === 'session') {
      if (ev.cwd) cwd = ev.cwd
      if (ev.createdAt) createdAt = ev.createdAt
    } else if (ev.type === 'session/title' && ev.data?.title) {
      title = ev.data.title
    } else if (ev.type === 'turn/start') {
      turns++
    } else if (isRealUserMessage(ev)) {
      userTexts.push(extractText(ev.data?.content))
    } else if (ev.type === 'assistant/message') {
      const t = extractText(ev.data?.message?.content)
      if (t) lastAssistant = t
    }
  }

  return {
    sessionId: entry.sessionId,
    title: title || (userTexts[0] ? userTexts[0].slice(0, 60) : '(untitled)'),
    cwd,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    updatedAt: new Date(entry.updatedAtMs).toISOString(),
    turns,
    userMessageCount: userTexts.length,
    firstUserMessage: userTexts[0] ? userTexts[0].slice(0, 200) : '',
    lastUserMessage: userTexts.length > 0 ? userTexts[userTexts.length - 1].slice(0, 200) : '',
    lastAssistantPreview: lastAssistant ? lastAssistant.slice(0, 240) : '',
  }
}

function readTranscript(sessionId, maxTurns = 20, includeToolOutputs = false) {
  const all = discoverSessions()
  if (all.length === 0) {
    return { error: 'No DSH Go sessions found under ' + SESSIONS_ROOT }
  }
  const target =
    !sessionId || sessionId === 'latest'
      ? all[0]
      : all.find((s) => s.sessionId === sessionId || s.sessionId.includes(sessionId))
  if (!target) {
    return { error: `Session not found: ${sessionId}` }
  }

  const events = readSessionLines(target.filePath)
  let title = ''
  let cwd = path.join(HOME, 'workspace')
  const items = []

  for (const ev of events) {
    if (ev.type === 'session' && ev.cwd) cwd = ev.cwd
    if (ev.type === 'session/title' && ev.data?.title) title = ev.data.title
    if (isRealUserMessage(ev)) {
      items.push({ role: 'user', time: ev.time, text: extractText(ev.data?.content).slice(0, 4000) })
    } else if (ev.type === 'assistant/message') {
      const text = extractText(ev.data?.message?.content)
      if (text) items.push({ role: 'assistant', time: ev.time, text: text.slice(0, 4000) })
    } else if (ev.type === 'tool/call') {
      const name = ev.data?.name || 'tool'
      const args =
        typeof ev.data?.arguments === 'string'
          ? ev.data.arguments.slice(0, 220)
          : JSON.stringify(ev.data?.arguments || '').slice(0, 220)
      items.push({ role: 'tool_call', name, args })
    } else if (includeToolOutputs && ev.type === 'tool/result') {
      const out = extractText(ev.data?.message?.content)
      if (out) items.push({ role: 'tool_result', text: out.slice(0, 800) })
    }
  }

  const limitItems = Math.max(10, Math.min(200, maxTurns * 8))
  const sliced = items.slice(-limitItems)
  const lines = [
    `Session: ${target.sessionId}`,
    `Title: ${title || '(untitled)'}`,
    `CWD: ${cwd}`,
    `Updated: ${new Date(target.updatedAtMs).toISOString()}`,
    `Showing ${sliced.length} of ${items.length} events:`,
    '---',
  ]
  for (const it of sliced) {
    if (it.role === 'user') lines.push(`[USER] ${it.text}`)
    else if (it.role === 'assistant') lines.push(`[ASSISTANT] ${it.text}`)
    else if (it.role === 'tool_call') lines.push(`[TOOL ${it.name}] ${it.args}`)
    else if (it.role === 'tool_result') lines.push(`[TOOL_RESULT] ${it.text}`)
  }

  return {
    sessionId: target.sessionId,
    title,
    cwd,
    transcript: lines.join('\n').slice(0, 28000),
  }
}

function resumeSession(sessionId, prompt, permissionMode = 'danger-full-access') {
  return new Promise((resolve) => {
    const all = discoverSessions()
    const target =
      !sessionId || sessionId === 'latest'
        ? all[0]
        : all.find((s) => s.sessionId === sessionId || s.sessionId.includes(sessionId))
    if (!target) {
      resolve({ error: `Session not found: ${sessionId}` })
      return
    }
    const meta = summarizeSession(target)
    const args = ['--profile', 'headless']
    for (const p of ['/opt/dsh-app/auth/auth.patch.yml', '/opt/dsh-app/phone/phone.patch.yml']) {
      if (fs.existsSync(p)) args.push('--patch', p)
    }
    args.push(
      '--session-id',
      target.sessionId,
      '--permission-mode',
      permissionMode,
      '--approval-policy',
      'never',
      prompt,
    )

    const fallbackCwd = path.join(HOME, 'workspace')
    const child = spawn(DSH_BIN, args, {
      cwd: fs.existsSync(meta.cwd) ? meta.cwd : fs.existsSync(fallbackCwd) ? fallbackCwd : HOME,
      env: { ...process.env, DSH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => resolve({ error: String(err) }))
    child.on('close', (code) => {
      resolve({
        sessionId: target.sessionId,
        exitCode: code,
        output: stdout.trim().slice(-24000),
        diagnostics: code !== 0 ? stderr.trim().slice(-4000) : undefined,
      })
    })
  })
}

const TOOLS = [
  {
    name: 'list_dsh_sessions',
    description:
      'List recent DSH Go chat sessions stored on this Android device (newest first), including session ID, title, working directory, turn count, and previews.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum sessions to return (default 15)', default: 15 },
      },
    },
  },
  {
    name: 'read_dsh_session',
    description:
      'Read the conversation history (user messages, assistant replies, and tool calls) from a DSH Go session on this phone. Pass "latest" to read the most recent DSH Go conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (or substring), or "latest" for the most recently updated DSH Go session.',
        },
        maxTurns: {
          type: 'integer',
          description: 'Approximate number of recent turns to include (default 20).',
          default: 20,
        },
        includeToolOutputs: {
          type: 'boolean',
          description: 'Include truncated tool outputs (default false).',
          default: false,
        },
      },
    },
  },
  {
    name: 'resume_dsh_session',
    description:
      'Continue an existing DSH Go session directly on this phone using `dsh --profile headless --session-id <id>`, preserving its model context and writing back to the same DSH Go session file. Avoid calling while the user is actively typing in the same session in DSH Go UI.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target DSH Go session ID (or "latest").' },
        prompt: { type: 'string', description: 'Follow-up instruction to send into that DSH Go session.' },
        permissionMode: {
          type: 'string',
          description: 'Permission preset (default "danger-full-access").',
          default: 'danger-full-access',
        },
      },
      required: ['sessionId', 'prompt'],
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = req
  if (id === undefined || id === null) return

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-sessions-bridge', version: '1.0.0' },
        },
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const toolName = params?.name
      const args = params?.arguments || {}
      let payload
      if (toolName === 'list_dsh_sessions') {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 15))
        payload = discoverSessions().slice(0, limit).map(summarizeSession)
      } else if (toolName === 'read_dsh_session') {
        payload = readTranscript(
          args.sessionId || 'latest',
          Number(args.maxTurns) || 20,
          Boolean(args.includeToolOutputs),
        )
      } else if (toolName === 'resume_dsh_session') {
        payload = await resumeSession(
          args.sessionId,
          String(args.prompt || ''),
          args.permissionMode || 'danger-full-access',
        )
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } })
        return
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
          isError: Boolean(payload?.error),
        },
      })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Error: ${err?.stack || err}` }],
        isError: true,
      },
    })
  }
})
