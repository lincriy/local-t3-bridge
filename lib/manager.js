import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME || '/root'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const T3_HOME = process.env.T3CODE_HOME || path.join(HOME, '.t3')
const BIN_DIR = path.join(HOME, '.local', 'bin')
const T3_BIN = path.join(BIN_DIR, 't3')
const ACP_WRAPPER = path.join(BIN_DIR, 'dsh-acp-for-t3')
const T3_PHONE_CLI = path.join(BIN_DIR, 't3-phone')
const WORKSPACE_DIR = fs.existsSync(path.join(HOME, 'workspace')) ? path.join(HOME, 'workspace') : HOME
const PID_FILE = path.join(T3_HOME, 't3-serve.pid')
const LOG_FILE = path.join(T3_HOME, 't3-serve.log')
const PORT = Number(process.env.T3_BRIDGE_PORT || 3773)
const BASE_URL = `http://127.0.0.1:${PORT}`
const DEFAULT_T3_VERSION = process.env.T3CODE_VERSION || '0.1.11'

const PROXY_SCRIPT = path.join(__dirname, 'acp-replay-proxy.mjs')
const SESSIONS_MCP_SCRIPT = path.join(__dirname, 'sessions-mcp.mjs')

let activeAuth = {
  proc: null,
  url: '',
  code: '',
  authorizedAs: '',
  error: '',
}

let cachedTunnelUrl = ''

function childEnv() {
  return {
    ...process.env,
    HOME,
    DSH_HOME,
    T3CODE_HOME: T3_HOME,
    PATH: `${BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd || HOME,
        env: childEnv(),
        timeout: opts.timeoutMs || 15000,
        maxBuffer: 4 * 1024 * 1024,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err,
        })
      },
    )
  })
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim()
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function countDshSessions() {
  const root = path.join(DSH_HOME, 'sessions')
  if (!fs.existsSync(root)) return 0
  let count = 0
  try {
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory() || ws.name.startsWith('.')) continue
      const wsDir = path.join(root, ws.name)
      for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('session-')) count++
      }
    }
  } catch {
    return 0
  }
  return count
}

async function probeLocalServer() {
  try {
    const res = await fetch(`${BASE_URL}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function queryConnectLinkState() {
  if (!fs.existsSync(T3_BIN)) return null
  const pairRes = await runCmd(T3_BIN, ['pair', '--ttl', '2m', '--label', 'DSH Go Bridge Check'], {
    timeoutMs: 10000,
  })
  const m = (pairRes.stdout + '\n' + pairRes.stderr).match(/Token:\s*([A-Z0-9-]+)/)
  if (!m) return null
  try {
    const boot = await fetch(`${BASE_URL}/api/auth/browser-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: m[1] }),
      signal: AbortSignal.timeout(4000),
    })
    if (!boot.ok) return null
    const setCookie = boot.headers.get('set-cookie')
    if (!setCookie) return null
    const cookie = setCookie.split(';')[0]
    const ls = await fetch(`${BASE_URL}/api/connect/link-state`, {
      headers: { cookie },
      signal: AbortSignal.timeout(4000),
    })
    if (!ls.ok) return null
    const data = await ls.json()
    if (data?.tunnelHostname) {
      cachedTunnelUrl = `https://${data.tunnelHostname}`
    }
    return data
  } catch {
    return null
  }
}

async function queryTunnelHostnameViaPair() {
  const data = await queryConnectLinkState()
  return data?.tunnelHostname ? `https://${data.tunnelHostname}` : ''
}

export async function getStatus(opts = {}) {
  const installed = fs.existsSync(T3_BIN)
  let version = ''
  if (installed) {
    const v = await runCmd(T3_BIN, ['--version'], { timeoutMs: 8000 })
    if (v.ok) version = v.stdout.trim()
  }

  const pid = readPid()
  const wellKnown = await probeLocalServer()
  const running = Boolean(wellKnown) || isPidAlive(pid)

  let connectState = '未授权'
  let tunnelReady = false
  let tunnelUrl = cachedTunnelUrl

  if (!installed) {
    connectState = '未安装'
  } else if (running) {
    // Prefer the running server's live /api/connect/link-state (fast and includes tunnelHostname)
    const live = await queryConnectLinkState()
    if (live) {
      if (live.tunnelHostname) tunnelUrl = `https://${live.tunnelHostname}`
      if (live.reachability?.status === 'reachable') {
        const conns = live.reachability.readyConnections || 1
        const proto = String(live.reachability.protocol || 'quic').toUpperCase()
        connectState = `在线 · ${conns} 连接 · ${proto}`
        tunnelReady = true
      } else if (live.linked && live.managedTunnelActive && live.tunnelHostname) {
        connectState = '在线 · 隧道已建立'
        tunnelReady = true
      } else if (live.linked) {
        connectState = '已授权 · 隧道连接中'
      } else {
        connectState = '未授权'
      }
    } else {
      const c = await runCmd(T3_BIN, ['connect', 'status', '--json'], { timeoutMs: 15000 })
      try {
        const parsed = JSON.parse(c.stdout)
        if (parsed?.reachability?.status === 'reachable') {
          const conns = parsed.reachability.readyConnections || 1
          const proto = String(parsed.reachability.protocol || 'quic').toUpperCase()
          connectState = `在线 · ${conns} 连接 · ${proto}`
          tunnelReady = true
        } else if (parsed?.authenticated || parsed?.linked) {
          connectState = '已授权 · 隧道连接中'
        }
      } catch {
        connectState = '状态检测超时，请点刷新'
      }
    }
  } else {
    const c = await runCmd(T3_BIN, ['connect', 'status', '--json'], { timeoutMs: 12000 })
    try {
      const parsed = JSON.parse(c.stdout)
      connectState = parsed?.authenticated || parsed?.linked ? '已授权 · 待启动服务' : '未授权'
    } catch {
      connectState = '未授权'
    }
  }

  if (tunnelReady && running && (!tunnelUrl || opts.refreshTunnel)) {
    const resolved = await queryTunnelHostnameViaPair()
    if (resolved) tunnelUrl = resolved
  }

  const configured =
    fs.existsSync(ACP_WRAPPER) &&
    fs.existsSync(path.join(T3_HOME, 'userdata', 'settings.json')) &&
    fs.existsSync(path.join(T3_HOME, 'dsh-sessions-mcp.patch.yml'))

  return {
    installed,
    version: version || '未安装',
    configured,
    running,
    pid: isPidAlive(pid) ? pid : null,
    environmentId: wellKnown?.environmentId || '',
    connectState,
    tunnelReady,
    tunnelUrl: tunnelUrl || '',
    sessionCount: countDshSessions(),
    authUrl: activeAuth.url,
    authCode: activeAuth.code,
    authorizedAs: activeAuth.authorizedAs,
  }
}

async function resolveLatestT3Version(signal) {
  if (process.env.T3CODE_VERSION) return process.env.T3CODE_VERSION
  try {
    const res = await fetch('https://github.com/pingdotgg/t3code/releases/latest', {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const data = await res.json()
      const m = String(data?.tag_name || '').match(/^v(\d+\.\d+\.\d+)$/)
      if (m) return m[1]
    }
  } catch {
    // Fallback to known-good version
  }
  return DEFAULT_T3_VERSION
}

function platformArch() {
  const archMap = { arm64: 'arm64', x64: 'x64' }
  const arch = archMap[process.arch]
  if (process.platform !== 'linux' || !arch) {
    throw new Error('当前环境不是支持的 Linux 架构')
  }
  return `linux-${arch}`
}

async function ensureT3Installed(signal) {
  if (fs.existsSync(T3_BIN)) {
    const check = await runCmd(T3_BIN, ['--version'], { timeoutMs: 5000, signal })
    if (check.ok && check.stdout.trim()) {
      return { version: check.stdout.trim(), freshlyInstalled: false }
    }
  }

  const target = platformArch()
  const version = await resolveLatestT3Version(signal)
  const archiveName = `t3-${version}-${target}.tar.gz`
  const baseUrl = `https://github.com/pingdotgg/t3code/releases/download/v${version}`

  const sumsRes = await fetch(`${baseUrl}/SHA256SUMS`, { signal })
  if (!sumsRes.ok) throw new Error('下载 T3 校验清单失败，请检查网络连接')
  const sumsText = await sumsRes.text()
  const sumLine = sumsText.split('\n').find((l) => l.trim().endsWith(archiveName))
  if (!sumLine) throw new Error('未找到当前架构对应的 T3 发行包')
  const expectedSha = sumLine.trim().split(/\s+/)[0]

  const archiveRes = await fetch(`${baseUrl}/${archiveName}`, { signal })
  if (!archiveRes.ok) throw new Error('下载 T3 安装包失败，请稍后重试')
  const archiveBuf = Buffer.from(await archiveRes.arrayBuffer())
  const actualSha = crypto.createHash('sha256').update(archiveBuf).digest('hex')
  if (actualSha !== expectedSha) throw new Error('T3 安装包校验失败，已中止安装')

  const versionsDir = path.join(T3_HOME, 'runtime', 'versions')
  const targetDir = path.join(versionsDir, version)
  const tmpTar = path.join(T3_HOME, `.${archiveName}.tmp`)
  fs.mkdirSync(targetDir, { recursive: true })
  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.writeFileSync(tmpTar, archiveBuf)

  try {
    const extract = await runCmd('tar', ['-xzf', tmpTar, '-C', targetDir, '--strip-components=1'], {
      timeoutMs: 45000,
      signal,
    })
    if (!extract.ok) throw new Error('解压 T3 安装包失败')
    fs.writeFileSync(path.join(targetDir, '.install-complete'), `${version}\n`)
    fs.writeFileSync(T3_BIN, `#!/bin/sh\nexec "${path.join(targetDir, 't3')}" "$@"\n`, { mode: 0o755 })
  } finally {
    try { fs.rmSync(tmpTar, { force: true }) } catch {}
  }

  return { version: `t3 v${version}`, freshlyInstalled: true }
}

export function writeBridgeConfig() {
  fs.mkdirSync(T3_HOME, { recursive: true })
  fs.mkdirSync(path.join(T3_HOME, 'userdata'), { recursive: true })
  fs.mkdirSync(BIN_DIR, { recursive: true })

  // 1. Sync user's web profile model config to acp and headless profiles
  const webPatch = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  if (fs.existsSync(webPatch)) {
    for (const prof of ['acp', 'headless']) {
      const profDir = path.join(DSH_HOME, 'profiles', prof)
      fs.mkdirSync(profDir, { recursive: true })
      fs.copyFileSync(webPatch, path.join(profDir, 'cordis.patch.yml'))
    }
  }

  // 2. Write DSH sessions MCP patch referencing this plugin's sessions-mcp.mjs
  const mcpPatch = [
    '- insert:',
    '    - id: dsh-sessions-bridge',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: dsh-sessions',
    '        transport: stdio',
    '        command: !!js process.execPath',
    '        args:',
    `          - ${JSON.stringify(SESSIONS_MCP_SCRIPT)}`,
    '        toolCallTimeoutMs: 300000',
    '        failOnStartupError: false',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(T3_HOME, 'dsh-sessions-mcp.patch.yml'), mcpPatch)

  // 3. Write ACP replay proxy wrapper for T3 Code Local ACP provider
  const nodeBin = process.execPath || '/opt/node/bin/node'
  const acpWrapperContent = [
    '#!/bin/sh',
    `export HOME="${HOME}"`,
    `export DSH_HOME="${DSH_HOME}"`,
    `export T3CODE_HOME="${T3_HOME}"`,
    'export TZ="${TZ:-Asia/Shanghai}"',
    'export UV_USE_IO_URING=0',
    `export PATH="${BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    'if [ -f /opt/dsh-go/direct/proot-dns.mjs ]; then',
    '  export NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=1024 --import=/opt/dsh-go/direct/proot-dns.mjs"',
    'else',
    '  export NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=1024"',
    'fi',
    `exec "${nodeBin}" "${PROXY_SCRIPT}" "$@"`,
    '',
  ].join('\n')
  fs.writeFileSync(ACP_WRAPPER, acpWrapperContent, { mode: 0o755 })

  // 4. Write t3-phone helper CLI
  const t3PhoneContent = [
    '#!/bin/sh',
    `export HOME="${HOME}"`,
    `export DSH_HOME="${DSH_HOME}"`,
    `export T3CODE_HOME="${T3_HOME}"`,
    `export PATH="${BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    `LOG="${LOG_FILE}"`,
    `PIDFILE="${PID_FILE}"`,
    'case "${1:-start}" in',
    '  start)',
    '    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then',
    '      echo "t3 serve already running (PID $(cat "$PIDFILE"))"; exit 0; fi',
    `    nohup "${T3_BIN}" serve --port ${PORT} --host 127.0.0.1 "${WORKSPACE_DIR}" > "$LOG" 2>&1 &`,
    '    echo $! > "$PIDFILE"; sleep 3',
    '    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { tail -n 30 "$LOG"; exit 1; }',
    '    echo "t3 serve started (PID $(cat "$PIDFILE"))" ;;',
    '  stop)',
    '    if [ -f "$PIDFILE" ]; then PID="$(cat "$PIDFILE")"; kill "$PID" 2>/dev/null || true;',
    '      i=0; while [ "$i" -lt 20 ] && kill -0 "$PID" 2>/dev/null; do sleep 0.5; i=$((i+1)); done;',
    '      rm -f "$PIDFILE"; echo "t3 serve stopped."; fi ;;',
    '  restart) "$0" stop; "$0" start ;;',
    `  status) [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && { echo "running ($(cat "$PIDFILE"))"; "${T3_BIN}" connect status 2>&1 | tail -n 5; } || echo "not running" ;;`,
    '  *) echo "Usage: t3-phone {start|stop|restart|status}"; exit 1 ;;',
    'esac',
    '',
  ].join('\n')
  fs.writeFileSync(T3_PHONE_CLI, t3PhoneContent, { mode: 0o755 })

  // 5. Merge settings.json safely (preserve existing user settings)
  const settingsPath = path.join(T3_HOME, 'userdata', 'settings.json')
  let settings = {}
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      settings = {}
    }
  }
  settings.linkedEnvironmentsEnabled = true
  settings.providerInstances = {
    ...(settings.providerInstances || {}),
    acpRegistry_dsh_go: {
      driver: 'acpRegistry',
      displayName: 'DSH Go (Android)',
      enabled: true,
      config: {
        source: 'local',
        commandPath: ACP_WRAPPER,
        commandArgs: [],
        distribution: 'auto',
      },
    },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

export async function installAndConfigure(signal) {
  const { version, freshlyInstalled } = await ensureT3Installed(signal)
  writeBridgeConfig()
  const running = Boolean(await probeLocalServer())
  if (running) {
    await runCmd(T3_BIN, ['project', 'add', WORKSPACE_DIR], { timeoutMs: 8000, signal })
  }
  return { version, freshlyInstalled }
}

export async function startServer(signal) {
  if (!fs.existsSync(T3_BIN)) {
    throw new Error('尚未安装 T3 Code，请先点击「安装并配置」')
  }
  writeBridgeConfig()
  if (await probeLocalServer()) {
    await runCmd(T3_BIN, ['project', 'add', WORKSPACE_DIR], { timeoutMs: 6000, signal })
    return { alreadyRunning: true }
  }

  fs.mkdirSync(T3_HOME, { recursive: true })
  const outFd = fs.openSync(LOG_FILE, 'w')
  const child = spawn(T3_BIN, ['serve', '--port', String(PORT), '--host', '127.0.0.1', WORKSPACE_DIR], {
    cwd: WORKSPACE_DIR,
    env: childEnv(),
    detached: true,
    stdio: ['ignore', outFd, outFd],
  })
  fs.writeFileSync(PID_FILE, `${child.pid}\n`)
  child.unref()
  fs.closeSync(outFd)

  for (let i = 0; i < 16; i++) {
    if (signal?.aborted) break
    await new Promise((r) => setTimeout(r, 500))
    if (await probeLocalServer()) {
      await runCmd(T3_BIN, ['project', 'add', WORKSPACE_DIR], { timeoutMs: 6000, signal })
      return { alreadyRunning: false, pid: child.pid }
    }
  }
  throw new Error('T3 服务启动超时，请检查端口或日志')
}

export async function stopServer() {
  const pid = readPid()
  if (!isPidAlive(pid)) {
    if (await probeLocalServer()) {
      throw new Error('服务由外部终端启动，当前无权限停止，请在原终端停止或重启手机')
    }
    try { fs.rmSync(PID_FILE, { force: true }) } catch {}
    return { wasRunning: false }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    if (err?.code === 'EPERM') {
      throw new Error('无权限停止该进程，请从原启动终端停止')
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(pid)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  try { fs.rmSync(PID_FILE, { force: true }) } catch {}
  cachedTunnelUrl = ''
  return { wasRunning: true }
}

export async function startConnectAuth(signal) {
  if (!fs.existsSync(T3_BIN)) {
    throw new Error('尚未安装 T3 Code，请先点击「安装并配置」')
  }
  if (activeAuth.proc) {
    try { activeAuth.proc.kill('SIGTERM') } catch {}
    activeAuth.proc = null
  }
  activeAuth = { proc: null, url: '', code: '', authorizedAs: '', error: '' }

  // Use python3 pty if available so the relay-client download prompt (y/N) answers automatically.
  const hasPython = fs.existsSync('/usr/local/bin/python3') || fs.existsSync('/usr/bin/python3')
  const pyBin = fs.existsSync('/usr/local/bin/python3') ? '/usr/local/bin/python3' : '/usr/bin/python3'

  const proc = hasPython
    ? spawn(
        pyBin,
        [
          '-u',
          '-c',
          [
            'import os, pty, select, sys, time',
            `os.chdir(${JSON.stringify(HOME)})`,
            'pid, fd = pty.fork()',
            `if pid == 0: os.execvp(${JSON.stringify(T3_BIN)}, ["t3", "connect", "link", "--headless"])`,
            'sent_y = False; buf = b""',
            'while True:',
            '  r, _, _ = select.select([fd], [], [], 1.0)',
            '  if r:',
            '    try: chunk = os.read(fd, 4096)',
            '    except OSError: break',
            '    if not chunk: break',
            '    sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush(); buf += chunk',
            '    if (not sent_y) and (b"Download and install" in buf or b"(y/N)" in buf):',
            '      time.sleep(0.3); os.write(fd, b"y\\n"); sent_y = True',
            '  elif os.waitpid(pid, os.WNOHANG)[0] != 0: break',
            '_, st = os.waitpid(pid, 0); sys.exit(os.waitstatus_to_exitcode(st))',
          ].join('\n'),
        ],
        { cwd: HOME, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : spawn(T3_BIN, ['connect', 'link', '--headless'], {
        cwd: HOME,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

  activeAuth.proc = proc

  return await new Promise((resolve, reject) => {
    let acc = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('等待 T3 Connect 授权链接超时，请检查网络'))
      }
    }, 45000)

    const onAbort = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        try { proc.kill('SIGTERM') } catch {}
        reject(new Error('已取消授权请求'))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const inspect = (chunk) => {
      acc += chunk.toString('utf8')
      const urlMatch = acc.match(/https:\/\/accounts\.t3\.codes\/device\?user_code=[A-Z0-9-]+/)
      const codeMatch = acc.match(/Code:\s*([A-Z0-9-]+)/)
      const authMatch = acc.match(/Authorized as\s+([^\s\r\n]+)/)
      if (urlMatch) activeAuth.url = urlMatch[0]
      if (codeMatch) activeAuth.code = codeMatch[1]
      if (authMatch) activeAuth.authorizedAs = authMatch[1]

      if (!settled && activeAuth.url && activeAuth.code) {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ url: activeAuth.url, code: activeAuth.code })
      } else if (!settled && activeAuth.authorizedAs) {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ alreadyAuthorized: true, authorizedAs: activeAuth.authorizedAs })
      }
    }

    proc.stdout.on('data', inspect)
    proc.stderr.on('data', inspect)
    proc.on('close', (code) => {
      if (activeAuth.proc === proc) activeAuth.proc = null
      if (!settled) {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (code === 0 && activeAuth.authorizedAs) {
          resolve({ alreadyAuthorized: true, authorizedAs: activeAuth.authorizedAs })
        } else {
          reject(new Error('未能获取 T3 Connect 授权链接，请检查网络后重试'))
        }
      }
    })
  })
}

export async function mintPairCode(signal) {
  if (!fs.existsSync(T3_BIN)) {
    throw new Error('尚未安装 T3 Code，请先安装并启动服务')
  }
  if (!(await probeLocalServer())) {
    throw new Error('T3 服务尚未启动，请先点击「启动服务」')
  }
  const res = await runCmd(T3_BIN, ['pair', '--ttl', '15m', '--label', 'Remote T3 Code'], {
    timeoutMs: 10000,
    signal,
  })
  const combined = `${res.stdout}\n${res.stderr}`
  const tokMatch = combined.match(/Token:\s*([A-Z0-9-]+)/)
  const expMatch = combined.match(/Expires:\s*([^\s\r\n]+)/)
  if (!tokMatch) throw new Error('生成配对码失败，请确认 T3 服务运行正常')

  const token = tokMatch[1]
  const expiresAt = expMatch ? expMatch[1] : ''
  const tunnelUrl = cachedTunnelUrl || (await queryTunnelHostnameViaPair())
  const targetUrl = tunnelUrl || '<你的手机 T3 Connect 地址>'
  const linkCommand = `t3 environment link ${targetUrl} --pairing-code ${token} --access full-access`
  return { token, expiresAt, tunnelUrl, linkCommand }
}
