/**
 * dsh-stable-mobile — 手机访问（稳定版）
 *
 * Makes the local DSH Web GUI reachable from a phone through *your own* server
 * at a **fixed URL with a fixed access password**, so the phone never has to
 * re-scan a per-process QR code.
 *
 * Architecture (nothing binds a non-loopback interface on this machine):
 *
 *   手机浏览器  https://<publicUrl>/
 *        │ nginx TLS + 反代（你的服务器）
 *        ▼
 *   服务器 127.0.0.1:<remotePort>   ← sshd 反向端口转发
 *        │ ssh -R（由本插件守护、断线自动重连）
 *        ▼
 *   本机 127.0.0.1:<port>           ← 网关：密码登录 + 会话注入
 *        │
 *        ▼
 *   DSH Web GUI 127.0.0.1:<webServer.port>（仍只监听 loopback）
 *
 * The one thing that makes this reliable where a plain proxy fails: the gateway
 * holds the harness session cookie itself and injects it into *every* request
 * and *every* WebSocket handshake. Mobile browsers that drop cookies on the
 * upgrade (MiuiBrowser, in-app webviews) therefore still get a working live
 * stream instead of an endless "重新连接中".
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createGateway, GATE_COOKIE, LOGIN_PATH, HEALTH_PATH } from './lib/gateway.js'
import { createTunnel, expandHome, resolveSshPath } from './lib/tunnel.js'
import { registerRoutes } from './lib/routes.js'
import { mintPassword, mintSecret, readState, statePath, writeState } from './lib/state.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stable-mobile'

/** We front the Web server and mint harness cookies through the connection service. */
export const inject = ['webServer', 'connection']

const LOOPBACK = '127.0.0.1'
const MAX_RESTARTS = 8

const DEFAULTS = {
  /** Start the phone entry again every time the harness starts. */
  enabled: false,
  /** Public server that terminates TLS and reverse-proxies to the tunnel. */
  serverHost: '',
  /** SSH port on that server. */
  serverPort: 22,
  /** SSH login on that server. */
  serverUser: 'ubuntu',
  /** Private key used for the reverse tunnel (`~` is expanded). */
  sshKeyPath: '~/.ssh/id_ed25519',
  /** Explicit ssh binary path; empty resolves the platform OpenSSH client. */
  sshPath: '',
  /** Loopback port the reverse tunnel binds on the server. */
  remotePort: 18081,
  /** Loopback port this gateway binds locally. */
  port: 18081,
  /** Public origin users open (no trailing slash, may include a port). */
  publicUrl: '',
  /** Phone browser session lifetime in hours (gate cookie). */
  sessionHours: 720,
  /** Run the SSH reverse tunnel; off = LAN-only debugging. */
  tunnel: true,
}

const BOOLEAN_FIELDS = new Set(['enabled', 'tunnel'])
const NUMBER_FIELDS = new Set(['serverPort', 'remotePort', 'port', 'sessionHours'])
const STRING_FIELDS = new Set(['serverHost', 'serverUser', 'sshKeyPath', 'sshPath', 'publicUrl'])

/** Plugin error carrying a stable code plus optional user-facing repair text. */
export function pluginError(code, message, { hint } = {}) {
  return Object.assign(new Error(message), { code, hint })
}

function normalizeUrl(value) {
  const text = String(value ?? '').trim()
  if (!/^https?:\/\/[^/]+/i.test(text)) {
    throw pluginError('BAD_VALUE', 'publicUrl 必须是 http(s):// 开头的完整地址，例如 https://example.com:7000')
  }
  return text.replace(/\/+$/, '')
}

/** Effective configuration: defaults under file overrides under the row config. */
export function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.serverHost = String(merged.serverHost ?? '').trim()
  merged.serverUser = String(merged.serverUser ?? '').trim() || DEFAULTS.serverUser
  merged.sshKeyPath = String(merged.sshKeyPath ?? '').trim() || DEFAULTS.sshKeyPath
  merged.sshPath = String(merged.sshPath ?? '').trim()
  merged.serverPort = Number.isInteger(merged.serverPort) && merged.serverPort >= 1 && merged.serverPort <= 65535
    ? merged.serverPort
    : DEFAULTS.serverPort
  merged.remotePort = Number.isInteger(merged.remotePort) && merged.remotePort >= 1024 && merged.remotePort <= 65535
    ? merged.remotePort
    : DEFAULTS.remotePort
  merged.port = Number.isInteger(merged.port) && merged.port >= 1024 && merged.port <= 65535
    ? merged.port
    : DEFAULTS.port
  merged.sessionHours = Number.isInteger(merged.sessionHours) && merged.sessionHours >= 1 && merged.sessionHours <= 720
    ? merged.sessionHours
    : DEFAULTS.sessionHours
  try {
    merged.publicUrl = merged.publicUrl === '' ? '' : normalizeUrl(merged.publicUrl)
  } catch {
    merged.publicUrl = ''
  }
  merged.enabled = merged.enabled === true
  merged.tunnel = merged.tunnel !== false
  return merged
}

/** Validate one patch value against its field's shape; throws a coded error. */
export function normalizeField(key, value) {
  if (BOOLEAN_FIELDS.has(key)) {
    if (typeof value !== 'boolean') throw pluginError('BAD_VALUE', `${key} 必须是布尔值`)
    return value
  }
  if (NUMBER_FIELDS.has(key)) {
    if (!Number.isInteger(value)) throw pluginError('BAD_VALUE', `${key} 必须是整数`)
    if (value < 1) throw pluginError('BAD_VALUE', `${key} 必须大于 0`)
    if ((key === 'port' || key === 'remotePort') && (value < 1024 || value > 65535)) {
      throw pluginError('BAD_VALUE', `${key} 必须在 1024–65535 之间`)
    }
    if (key === 'serverPort' && value > 65535) throw pluginError('BAD_VALUE', 'serverPort 必须在 1–65535 之间')
    if (key === 'sessionHours' && value > 720) throw pluginError('BAD_VALUE', 'sessionHours 最多 720 小时')
    return value
  }
  if (STRING_FIELDS.has(key)) {
    if (typeof value !== 'string') throw pluginError('BAD_VALUE', `${key} 必须是字符串`)
    const text = value.trim()
    if (key === 'publicUrl') return text === '' ? '' : normalizeUrl(text)
    if (key === 'serverHost' && text.length === 0) return ''
    if (key === 'serverUser' && text.length === 0) throw pluginError('BAD_VALUE', 'serverUser 不能为空')
    if (key === 'sshKeyPath' && text.length === 0) throw pluginError('BAD_VALUE', 'sshKeyPath 不能为空')
    return text
  }
  throw pluginError('UNKNOWN_FIELD', `未知配置项 ${JSON.stringify(key)}`)
}

export function apply(ctx, config) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = statePath(home)

  /** Card-edited overrides, persisted in the state file. */
  let stateConfig = {}
  let configLoaded = false
  let password
  let gateSecret
  let passwordRotatedAt

  let current = resolveConfig({ ...(config ?? {}), ...stateConfig })
  let gateway
  let tunnel
  let phase = 'stopped'
  let lastError
  let restartTimer
  let restartAttempt = 0
  let queue
  let stopped = false

  const log = (level, message) => {
    const logger = ctx.logger
    const write = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : undefined
    if (write !== undefined) write(message)
  }

  function noteError(error) {
    lastError = {
      code: error?.code ?? 'STABLE_MOBILE_ERROR',
      message: error?.message ?? String(error),
      ...(error?.hint === undefined ? {} : { hint: error.hint }),
      at: Date.now(),
    }
    log('error', `stable-mobile: ${lastError.code}: ${lastError.message}${lastError.hint === undefined ? '' : ` (${lastError.hint})`}`)
  }

  /**
   * Mint a harness browser cookie by exchanging the process token over loopback.
   * This is the plugin's only credential path: it never touches any third-party
   * plugin route, so installing this package is enough.
   */
  async function mintHarnessCookie() {
    const port = ctx.webServer.port
    const url = ctx.connection.authenticatedUrl(`http://${LOOPBACK}:${String(port)}`)
    const response = await fetch(url, { redirect: 'manual' })
    const list = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')]
    const header = (list ?? []).find((item) => typeof item === 'string' && item.startsWith('dsh-auth-'))
    if (header === undefined) {
      throw pluginError(
        'HARNESS_COOKIE_UNAVAILABLE',
        `harness 没有返回浏览器 Cookie（HTTP ${String(response.status)}）`,
        { hint: '确认 dsh web 仍在运行，然后点“重启网关”' },
      )
    }
    return header.split(';')[0]
  }

  async function loadState() {
    const state = await readState(file)
    if (state.corrupt !== undefined) log('warn', `stable-mobile: 状态文件损坏，将重建：${state.corrupt}`)
    stateConfig = state.config ?? {}
    let dirty = false
    if (typeof state.password === 'string') {
      password = state.password
    } else {
      password = mintPassword()
      dirty = true
      log('info', `stable-mobile: 已生成访问密码 ${file}`)
    }
    if (typeof state.gateSecret === 'string') {
      gateSecret = state.gateSecret
    } else {
      gateSecret = mintSecret(32)
      dirty = true
    }
    if (dirty) await persistState()
    configLoaded = true
    current = resolveConfig({ ...(config ?? {}), ...stateConfig })
  }

  async function persistState() {
    await writeState(file, { password, gateSecret, config: stateConfig })
  }

  function effectiveConfig() {
    const snapshot = { ...current }
    delete snapshot.sshPath
    return {
      ...snapshot,
      sshKeyPathExpanded: expandHome(current.sshKeyPath),
      sshBinary: resolveSshPath(current.sshPath),
    }
  }

  function loginUrl() {
    if (typeof current.publicUrl !== 'string' || current.publicUrl.length === 0) return undefined
    return `${current.publicUrl}${LOGIN_PATH}`
  }

  async function status() {
    const cfg = effectiveConfig()
    return {
      enabled: current.enabled === true,
      phase,
      publicUrl: cfg.publicUrl,
      loginUrl: loginUrl(),
      localUrl: `http://${LOOPBACK}:${String(cfg.port)}/`,
      /** The access password is intentionally shown: the desktop card is loopback-only. */
      password: typeof password === 'string' ? password : '',
      passwordRotatedAt,
      tunnelEnabled: cfg.tunnel === true,
      config: cfg,
      gateway: gateway?.status() ?? { listening: false, port: cfg.port, harnessCookieCached: false },
      tunnel: tunnel?.status() ?? { state: 'stopped', attempts: 0, stderrTail: [] },
      restartAttempt,
      lastError,
      updatedAt: Date.now(),
    }
  }

  async function stopActive() {
    const closing = { gateway, tunnel }
    gateway = undefined
    tunnel = undefined
    try {
      closing.tunnel?.stop()
    } catch (error) {
      log('warn', `stable-mobile: tunnel stop failed: ${String(error?.message ?? error)}`)
    }
    try {
      await closing.gateway?.close()
    } catch (error) {
      log('warn', `stable-mobile: gateway close failed: ${String(error?.message ?? error)}`)
    }
  }

  function scheduleTunnelRestart(reason) {
    if (stopped || current.enabled !== true || current.tunnel !== true) return
    restartAttempt += 1
    if (restartAttempt > MAX_RESTARTS) {
      phase = 'error'
      noteError(pluginError('TUNNEL_RESTART_EXHAUSTED', `SSH 隧道连续失败，已停止重试（${reason}）`, {
        hint: '检查服务器是否可达、密钥是否有效、远端端口是否被占用，然后点“重启网关”',
      }))
      return
    }
    phase = 'starting'
  }

  async function start(cfg) {
    phase = 'starting'
    try {
      if (cfg.tunnel === true && cfg.serverHost.length === 0) {
        throw pluginError('SERVER_NOT_CONFIGURED', '还没有填写服务器地址', {
          hint: '在“高级设置”里填入你的服务器域名或 IP，并确认已在服务器上配好 nginx TLS 反代',
        })
      }

      gateway = createGateway({
        password,
        gateSecret,
        port: cfg.port,
        sessionHours: cfg.sessionHours,
        upstreamPort: () => ctx.webServer.port,
        resolveHarnessCookie: mintHarnessCookie,
        log: (level, message) => log(level, message),
      })
      await gateway.listen()

      if (cfg.tunnel === true) {
        tunnel = createTunnel({
          sshPath: resolveSshPath(cfg.sshPath),
          serverHost: cfg.serverHost,
          serverPort: cfg.serverPort,
          serverUser: cfg.serverUser,
          keyPath: expandHome(cfg.sshKeyPath),
          remotePort: cfg.remotePort,
          localPort: cfg.port,
          log: (level, message) => log(level, message),
        })
        tunnel.onExit((info) => {
          if (stopped || current.enabled !== true) return
          scheduleTunnelRestart(info?.message ?? `ssh 退出码 ${String(info?.code)}`)
        })
        await tunnel.start()
      }

      phase = 'running'
      lastError = undefined
      restartAttempt = 0
      log('info', `stable-mobile: 就绪 — ${cfg.publicUrl === '' ? `${LOOPBACK}:${String(cfg.port)}（仅本机）` : cfg.publicUrl} -> 127.0.0.1:${String(ctx.webServer.port)}`)
    } catch (error) {
      noteError(error)
      phase = 'error'
      await stopActive()
    }
  }

  function configKey(cfg) {
    return JSON.stringify({
      enabled: cfg.enabled === true,
      serverHost: cfg.serverHost,
      serverPort: cfg.serverPort,
      serverUser: cfg.serverUser,
      sshKeyPath: cfg.sshKeyPath,
      sshPath: cfg.sshPath,
      remotePort: cfg.remotePort,
      port: cfg.port,
      publicUrl: cfg.publicUrl,
      sessionHours: cfg.sessionHours,
      tunnel: cfg.tunnel === true,
      webPort: ctx.webServer.port,
      // Both secrets are part of the key: rotating either must rebuild.
      password,
      gateSecret,
    })
  }

  let activeKey

  async function sync({ force = false } = {}) {
    if (!configLoaded || stopped) return
    current = resolveConfig({ ...(config ?? {}), ...stateConfig })
    const key = configKey(current)
    if (!force && key === activeKey) return
    activeKey = key
    clearTimeout(restartTimer)
    restartTimer = undefined
    await stopActive()
    if (current.enabled !== true) {
      phase = 'stopped'
      lastError = undefined
      restartAttempt = 0
      return
    }
    await start(current)
  }

  const schedule = () => {
    queue ??= Promise.resolve()
    queue = queue.then(() => sync(), () => sync())
    return queue
  }

  function restart() {
    activeKey = undefined
    restartAttempt = 0
    queue ??= Promise.resolve()
    queue = queue.then(() => sync({ force: true }), () => sync({ force: true }))
    return queue
  }

  async function setConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw pluginError('BAD_PATCH', 'set 需要普通对象')
    }
    const clean = {}
    for (const [key, value] of Object.entries(patch)) clean[key] = normalizeField(key, value)
    stateConfig = { ...stateConfig, ...clean }
    await persistState()
    return effectiveConfig()
  }

  async function resetConfig() {
    stateConfig = {}
    await persistState()
    return effectiveConfig()
  }

  async function rotatePassword() {
    password = mintPassword()
    gateSecret = mintSecret(32)
    passwordRotatedAt = Date.now()
    await persistState()
    log('info', 'stable-mobile: 访问密码已重置，旧密码与已登录设备立即失效')
    await restart()
    return { password, passwordRotatedAt }
  }

  const api = {
    status,
    start: async () => {
      await setConfig({ enabled: true })
      await schedule()
    },
    stop: async () => {
      await setConfig({ enabled: false })
      await schedule()
    },
    restart,
    rotatePassword,
    set: async (patch) => {
      const configAfter = await setConfig(patch)
      await schedule()
      return configAfter
    },
    reset: async () => {
      const configAfter = await resetConfig()
      await schedule()
      return configAfter
    },
  }

  ctx.effect(() => {
    const dispose = registerRoutes(ctx, api, { log: (level, message) => log(level, message) })
    return dispose
  }, 'stable-mobile:routes')

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(restartTimer)
    restartTimer = undefined
    queue ??= Promise.resolve()
    queue = queue.then(() => stopActive(), () => stopActive())
    return queue
  }, 'stable-mobile:shutdown')

  void (async () => {
    try {
      await loadState()
    } catch (error) {
      noteError(error)
      phase = 'error'
      return
    }
    if (stopped) return
    await schedule()
  })()
}

export { GATE_COOKIE, HEALTH_PATH }
