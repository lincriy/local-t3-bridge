// local-t3-bridge: native DSH Go plugin for running T3 Code on Android inside
// DSH Go's built-in Linux container with full ACP session history replay.
import {
  getStatus,
  installAndConfigure,
  startServer,
  stopServer,
  startConnectAuth,
  mintPairCode,
} from './manager.js'

export const name = 'local-t3-bridge'

const friendlyError = (err, fallback) => {
  const msg = String(err?.message || '').trim()
  return /[\u3400-\u9fff]/u.test(msg) ? msg.slice(0, 80) : fallback
}

export function apply(ctx) {
  // Keep transient session pairing command in memory only (never persisted to disk/manifest)
  let latestPairCommand = ''
  let latestAuthUrl = ''

  function buildPatch(status, tip, extra = {}) {
    if (status.authUrl) latestAuthUrl = status.authUrl
    return {
      version: status.installed ? status.version : '未安装',
      service: status.running
        ? status.pid
          ? `运行中（PID ${status.pid}）`
          : '运行中'
        : '已停止',
      connect: status.connectState,
      tunnelUrl: status.tunnelUrl || '未生成（需完成 T3 Connect 授权并启动服务）',
      sessions: `${status.sessionCount} 个会话可原生导入`,
      tip,
      ...extra,
    }
  }

  ctx.inject(['dshGo'], (scope) => {
    scope.dshGo.panel('t3-bridge', {
      view: () => ({
        type: 'stack',
        title: 'T3 跨端互联',
        children: [
          {
            type: 'text',
            text: '在 DSH Go 容器内运行官方 T3 Code，免 Root、免 Termux 实现手机与电脑对等互联，并原生同步 DSH Go 聊天记录与无障碍操控能力。',
            tone: 'muted',
          },
          {
            type: 'keyValue',
            items: [
              { label: 'T3 版本', value: { $: 'data.version' } },
              { label: '服务状态', value: { $: 'data.service' } },
              { label: 'T3 Connect', value: { $: 'data.connect' } },
              { label: '远程地址', value: { $: 'data.tunnelUrl' } },
              { label: '本机会话', value: { $: 'data.sessions' } },
            ],
          },
          {
            type: 'callout',
            text: { $: 'data.tip' },
            tone: 'info',
          },
          {
            type: 'actions',
            items: [
              { label: '安装并配置', action: 'install', icon: 'download', style: 'primary' },
              { label: '启动服务', action: 'start', icon: 'play' },
              { label: '停止服务', action: 'stop', icon: 'stop' },
              { label: '刷新状态', action: 'refresh', icon: 'refresh' },
            ],
          },
          {
            type: 'actions',
            items: [
              { label: 'T3 账号授权', action: 'connect', icon: 'cloud' },
              { label: '打开授权页', action: 'open-auth', icon: 'external' },
              { label: '生成配对码', action: 'pair', icon: 'qr' },
              { label: '复制互联命令', action: 'copy-link', icon: 'copy' },
            ],
          },
        ],
      }),
      data: (_scope, emit) => {
        emit({
          version: '检测中',
          service: '检测中',
          connect: '检测中',
          tunnelUrl: '检测中',
          sessions: '检测中',
          tip: '正在读取 T3 状态，也可点击下方按钮操作。',
        })
        let disposed = false
        getStatus()
          .then((st) => {
            if (disposed) return
            const tip = !st.installed
              ? '第 1 步：点击「安装并配置」下载 T3 ARM64 并自动写入代理配置。'
              : !st.running
                ? 'T3 已就绪，点击「启动服务」上线；首次跨网互联请点「T3 账号授权」。'
                : st.tunnelReady
                  ? 'T3 Connect 已连通，可点击「生成配对码」在电脑端互联，或直接用 T3 客户端切到本机导入历史会话。'
                  : '服务已启动，点击「T3 账号授权」绑定账号即可外网直连。'
            emit(buildPatch(st, tip))
          })
          .catch(() => {
            if (!disposed) emit({ tip: '读取状态失败，请点击「刷新状态」重试。' })
          })
        return () => {
          disposed = true
        }
      },
      actions: {
        refresh: () => ({
          pending: { label: '正在刷新状态', timeoutMs: 18000 },
          result: async () => {
            try {
              const st = await getStatus({ refreshTunnel: true })
              return {
                patch: buildPatch(st, st.tunnelReady ? '状态已更新，隧道在线。' : '状态已更新。'),
                toast: '状态已刷新',
              }
            } catch (err) {
              return { toast: friendlyError(err, '刷新状态失败') }
            }
          },
        }),
        install: () => ({
          pending: { label: '正在安装 T3', timeoutMs: 60000 },
          result: async (signal) => {
            try {
              const r = await installAndConfigure(signal)
              const st = await getStatus()
              const tip = r.freshlyInstalled
                ? `已安装 ${r.version} 并配置好 ACP 历史回放与会话桥，点击「启动服务」即可运行。`
                : `已检测到 ${r.version}，已同步最新 ACP 历史回放与会话桥配置。`
              return { patch: buildPatch(st, tip), toast: '安装并配置完成' }
            } catch (err) {
              const msg = friendlyError(err, '安装失败，请检查网络后重试')
              return { patch: { tip: msg }, toast: msg }
            }
          },
        }),
        start: () => ({
          pending: { label: '正在启动服务', timeoutMs: 25000 },
          result: async (signal) => {
            try {
              await startServer(signal)
              const st = await getStatus({ refreshTunnel: true })
              return {
                patch: buildPatch(st, 'T3 服务已启动，隧道连接通常需要 5–10 秒，可稍后点「刷新状态」。'),
                toast: 'T3 服务已启动',
              }
            } catch (err) {
              const msg = friendlyError(err, '启动服务失败')
              return { patch: { tip: msg }, toast: msg }
            }
          },
        }),
        stop: () => ({
          pending: { label: '正在停止服务', timeoutMs: 18000 },
          result: async () => {
            try {
              await stopServer()
              const st = await getStatus()
              return { patch: buildPatch(st, 'T3 服务已停止。'), toast: '服务已停止' }
            } catch (err) {
              const msg = friendlyError(err, '停止服务失败')
              return { patch: { tip: msg }, toast: msg }
            }
          },
        }),
        connect: () => ({
          pending: { label: '正在获取授权码', timeoutMs: 55000 },
          result: async (signal) => {
            try {
              const res = await startConnectAuth(signal)
              if (res.alreadyAuthorized) {
                const st = await getStatus({ refreshTunnel: true })
                return {
                  patch: buildPatch(st, `已完成 T3 Connect 授权（${res.authorizedAs}），重启服务后隧道生效。`),
                  toast: '账号已授权',
                }
              }
              latestAuthUrl = res.url
              const st = await getStatus()
              return {
                patch: buildPatch(
                  st,
                  `验证码：${res.code}。请点击「打开授权页」完成登录，授权完成后重启服务即可上线。`,
                ),
                toast: `授权码 ${res.code}`,
              }
            } catch (err) {
              const msg = friendlyError(err, '获取授权链接失败，请检查网络')
              return { patch: { tip: msg }, toast: msg }
            }
          },
        }),
        'open-auth': () => {
          if (!latestAuthUrl || !latestAuthUrl.startsWith('https://')) {
            return { toast: '请先点击「T3 账号授权」获取链接' }
          }
          return { link: latestAuthUrl }
        },
        pair: () => ({
          pending: { label: '正在生成配对码', timeoutMs: 18000 },
          result: async (signal) => {
            try {
              const r = await mintPairCode(signal)
              latestPairCommand = r.linkCommand
              const st = await getStatus()
              return {
                patch: buildPatch(
                  st,
                  `已生成 15 分钟有效配对码，点击「复制互联命令」粘贴到电脑终端即可互联。`,
                ),
                toast: '配对码已生成',
              }
            } catch (err) {
              const msg = friendlyError(err, '生成配对码失败')
              return { patch: { tip: msg }, toast: msg }
            }
          },
        }),
        'copy-link': () => {
          if (!latestPairCommand) {
            return { toast: '请先点击「生成配对码」' }
          }
          return { copy: latestPairCommand, toast: '已复制互联命令' }
        },
      },
    })
  })
}
