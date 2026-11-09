/**
 * dsh-stable-mobile — SSH reverse-tunnel supervisor (lib/tunnel.js).
 *
 * Keeps this up:
 *
 *   ssh -N -R 127.0.0.1:<remotePort>:127.0.0.1:<localPort> user@host
 *
 * so the server's nginx can reach the loopback gateway on this machine. The
 * server needs only sshd plus an nginx TLS site that proxies to
 * 127.0.0.1:<remotePort>; nothing binds a non-loopback interface here and no
 * inbound port is opened on this machine.
 *
 * Everything user-specific (host, user, key, ports) comes from the caller's
 * config, so the same package works for any machine.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_STDERR_LINES = 60
const READY_TIMEOUT_MS = 12_000
const MAX_BACKOFF_MS = 30_000
const READY_MARKERS = ['remote forward success', 'Remote forwarding listening on']

/** Expand a leading `~` so a user-edited config path keeps working. */
export function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Resolve the OpenSSH client binary; Windows ships one under System32. */
export function resolveSshPath(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return expandHome(explicit)
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    const candidate = join(root, 'System32', 'OpenSSH', 'ssh.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'ssh'
}

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Build the exact argv; exported so tests can assert it without spawning. */
export function buildArgs({ serverHost, serverPort = 22, serverUser, keyPath, remotePort, localPort, connectTimeout = 10 }) {
  if (typeof serverHost !== 'string' || serverHost.trim().length === 0) throw coded('BAD_SERVER_HOST', 'serverHost is required')
  if (typeof serverUser !== 'string' || serverUser.trim().length === 0) throw coded('BAD_SERVER_USER', 'serverUser is required')
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw coded('BAD_REMOTE_PORT', 'remotePort must be a TCP port')
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw coded('BAD_LOCAL_PORT', 'localPort must be a TCP port')
  if (typeof keyPath !== 'string' || keyPath.trim().length === 0) throw coded('BAD_KEY_PATH', 'sshKeyPath is required')

  const expanded = expandHome(keyPath)
  if (!existsSync(expanded)) throw coded('SSH_KEY_MISSING', `SSH private key not found: ${expanded}`)

  return {
    keyPath: expanded,
    args: [
      '-N',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${String(connectTimeout)}`,
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes',
      '-i', expanded,
      '-R', `127.0.0.1:${String(remotePort)}:127.0.0.1:${String(localPort)}`,
      '-p', String(Number.isInteger(serverPort) && serverPort > 0 ? serverPort : 22),
      `${serverUser}@${serverHost}`,
    ],
  }
}

/**
 * One supervised ssh process with exponential backoff.
 *
 * @returns `{ start, stop, status, onExit }`.
 */
export function createTunnel(options = {}) {
  const {
    sshPath,
    serverHost,
    serverPort,
    serverUser,
    keyPath,
    remotePort,
    localPort,
    log = () => {},
  } = options

  let child
  let state = 'stopped'
  let since
  let lastError
  let stderrLines = []
  let restartTimer
  let attempt = 0
  let wanted = false
  let readyTimer
  let readyResolve
  let readyReject
  const exitListeners = new Set()

  const emitExit = (info) => {
    for (const listener of [...exitListeners]) {
      try {
        listener(info)
      } catch {
        /* observers must never break supervision */
      }
    }
  }

  const noteLine = (line) => {
    const text = String(line).trim()
    if (text.length === 0) return
    stderrLines.push(text)
    if (stderrLines.length > MAX_STDERR_LINES) stderrLines = stderrLines.slice(-MAX_STDERR_LINES)
    const lower = text.toLowerCase()
    if (
      lower.includes('permission denied')
      || lower.includes('remote port forwarding failed')
      || lower.includes('address already in use')
      || lower.includes('connection refused')
    ) {
      lastError = { message: text, at: Date.now() }
    }
    if (state === 'starting' && READY_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) {
      state = 'running'
      since = Date.now()
      lastError = undefined
      attempt = 0
      clearTimeout(readyTimer)
      readyResolve?.({ state, pid: child?.pid })
      readyResolve = undefined
      readyReject = undefined
      log('info', `stable-mobile: ssh tunnel ready (${serverUser}@${serverHost}:${remotePort} -> 127.0.0.1:${localPort})`)
    }
  }

  function spawnOnce() {
    const built = buildArgs({ serverHost, serverPort, serverUser, keyPath, remotePort, localPort })
    const binary = resolveSshPath(sshPath)
    state = 'starting'
    since = Date.now()
    lastError = undefined
    stderrLines = []
    log('info', `stable-mobile: launching ${binary} ${built.args.join(' ')}`)

    child = spawn(binary, built.args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })

    let pending = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      pending += chunk
      for (;;) {
        const nl = pending.indexOf('\n')
        if (nl < 0) break
        noteLine(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
      }
    })

    child.on('error', (error) => {
      state = 'exited'
      lastError = { message: `cannot start ssh: ${error.message}`, at: Date.now() }
      clearTimeout(readyTimer)
      readyReject?.(coded('SSH_SPAWN_FAILED', lastError.message))
      readyResolve = undefined
      readyReject = undefined
    })

    child.on('exit', (code, signal) => {
      const wasReady = state === 'running'
      state = 'exited'
      child = undefined
      clearTimeout(readyTimer)
      if (readyReject !== undefined) {
        readyReject(coded('SSH_TUNNEL_EXITED', lastError?.message ?? `ssh exited before the tunnel was ready (code ${String(code)})`))
        readyResolve = undefined
        readyReject = undefined
      }
      const detail = lastError?.message ?? (stderrLines.at(-1) ?? `ssh exited (code ${String(code)})`)
      log(wasReady ? 'warn' : 'error', `stable-mobile: ssh tunnel exited: ${detail}`)
      emitExit({ code, signal, message: detail })
      if (wanted) scheduleRestart(detail)
    })

    return new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      readyTimer = setTimeout(() => {
        // Some ssh builds stay silent on success; a live process after the grace
        // period is treated as ready so a quiet but working tunnel is not killed.
        if (child !== undefined && state === 'starting') {
          state = 'running'
          since = Date.now()
          attempt = 0
          log('info', 'stable-mobile: ssh tunnel assumed ready (no ready marker within timeout)')
          resolve({ state, pid: child.pid })
          readyResolve = undefined
          readyReject = undefined
        }
      }, READY_TIMEOUT_MS)
      readyTimer.unref?.()
    })
  }

  function scheduleRestart(reason) {
    if (!wanted) return
    attempt += 1
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt - 1, 5))
    state = 'starting'
    log('warn', `stable-mobile: ssh tunnel lost (${reason}); retrying in ${String(delay)}ms (attempt ${String(attempt)})`)
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      if (!wanted) return
      spawnOnce().catch((error) => {
        log('error', `stable-mobile: ssh restart failed: ${String(error?.message ?? error)}`)
        emitExit({ code: null, signal: null, message: String(error?.message ?? error) })
      })
    }, delay)
    restartTimer.unref?.()
  }

  function start() {
    wanted = true
    if (state === 'starting' || state === 'running') return Promise.resolve({ state, pid: child?.pid })
    attempt = 0
    return spawnOnce()
  }

  function stop() {
    wanted = false
    clearTimeout(restartTimer)
    restartTimer = undefined
    clearTimeout(readyTimer)
    if (readyReject !== undefined) {
      readyReject(coded('SSH_TUNNEL_STOPPED', 'tunnel stopped before it was ready'))
      readyResolve = undefined
      readyReject = undefined
    }
    const current = child
    child = undefined
    state = 'stopped'
    since = undefined
    if (current !== undefined && current.exitCode === null) {
      try {
        current.kill()
      } catch {
        /* already gone */
      }
      const timer = setTimeout(() => {
        try {
          current.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 1500)
      timer.unref?.()
    }
  }

  const status = () => ({
    state,
    pid: child?.pid,
    since,
    attempts: attempt,
    lastError,
    stderrTail: [...stderrLines].slice(-12),
  })

  return {
    start,
    stop,
    status,
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
  }
}
