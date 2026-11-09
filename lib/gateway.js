/**
 * dsh-stable-mobile — the gateway (lib/gateway.js).
 *
 * A small reverse proxy that binds loopback and makes a remote browser look
 * like a loopback client of the DSH harness, with one crucial difference from a
 * plain proxy: it owns the harness session cookie server-side and *injects* it
 * into every HTTP request and every WebSocket handshake.
 *
 * Why injection matters: several mobile browsers (MiuiBrowser, some WeChat and
 * in-app webviews) send cookies on ordinary XHR/fetch but drop them on the
 * WebSocket upgrade. Without injection those clients load the UI fine and then
 * sit forever on "重新连接中" because /api/remote.mux answers 401. Injecting the
 * cookie server-side makes the transport irrelevant.
 *
 * The browser only ever holds `dsh_stable_gate`: an HMAC-signed, HttpOnly
 * cookie minted by the password login page. The harness cookie itself is never
 * sent to a client.
 */

import http from 'node:http'
import net from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const LOGIN_PATH = '/__stable/login'
export const HEALTH_PATH = '/__stable/health'
export const GATE_COOKIE = 'dsh_stable_gate'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Client headers that describe the public origin or the harness session. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
])

const MAX_HEAD_BYTES = 64 * 1024
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_LOGIN_BODY = 4 * 1024
const SESSION_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FAILURE_LIMIT = 10
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const BLOCK_MS = 10 * 60 * 1000

/**
 * Login page. Deliberately dependency-free and mobile-first: one password box,
 * no JavaScript, works in any webview.
 */
const loginPage = ({ failed = false, blocked = false } = {}) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>DeepSeek Harness · 手机访问</title>
<style>
 :root{color-scheme:dark;--accent:#4c8dff}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;
   font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
   background:#0b0d10;color:#e8eaed}
 form{width:min(92vw,380px);padding:28px 24px;border-radius:16px;background:#15181d;
   border:1px solid #262b33}
 h1{margin:0 0 4px;font-size:19px}
 p.sub{margin:0 0 20px;color:#9aa0a6;font-size:13px}
 input{width:100%;padding:12px 13px;border-radius:10px;border:1px solid #333941;
   background:#0e1116;color:inherit;font-size:16px;letter-spacing:.02em}
 button{margin-top:12px;width:100%;padding:12px;border-radius:10px;border:0;
   background:var(--accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 .err{margin:0 0 14px;color:#ff8a80;font-size:13px}
 .tip{margin:18px 0 0;color:#6f757d;font-size:12px;text-align:center;line-height:1.7}
</style></head>
<body><form method="post" action="${LOGIN_PATH}">
 <h1>DeepSeek Harness</h1>
 <p class="sub">手机访问 · 与桌面同一个界面、同一份实时会话</p>
 ${blocked ? '<p class="err">尝试次数过多，请稍后再试。</p>'
   : failed ? '<p class="err">访问密码不正确。</p>' : ''}
 <input type="password" name="p" autofocus autocomplete="current-password"
        placeholder="访问密码" required>
 <button type="submit">进入</button>
 <p class="tip">首次输入访问密码后会自动记住 30 天，<br>之后打开这个网址即可直接查看实时进度。</p>
</form></body></html>`

function constantTimeEqualString(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function headerValue(headers, name) {
  const direct = headers?.[name]
  if (typeof direct === 'string') return direct
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  }
  return undefined
}

function cookiesOf(headers) {
  const jar = new Map()
  const raw = headerValue(headers, 'cookie')
  if (typeof raw !== 'string') return jar
  for (const segment of raw.split(';')) {
    const eq = segment.indexOf('=')
    if (eq <= 0) continue
    jar.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim())
  }
  return jar
}

/**
 * One gateway instance.
 *
 * @param options.password - access password shown to the phone user.
 * @param options.gateSecret - signing key for the browser gate cookie.
 * @param options.port - loopback port to bind.
 * @param options.upstreamPort - live getter for the harness web port.
 * @param options.resolveHarnessCookie - async () => "name=value"; mints or
 *   reuses a harness browser cookie. Called on demand and after a 401.
 * @param options.sessionHours - gate cookie lifetime.
 * @param options.log - (level, message) => void.
 */
export function createGateway(options = {}) {
  const {
    password,
    gateSecret,
    port = 18081,
    sessionHours = 720,
    log = () => {},
  } = options

  if (typeof password !== 'string' || password.length === 0) {
    throw Object.assign(new Error('gateway requires an access password'), { code: 'BAD_PASSWORD' })
  }
  if (typeof gateSecret !== 'string' || gateSecret.length < 16) {
    throw Object.assign(new Error('gateway requires a gate secret (>= 16 chars)'), { code: 'BAD_SECRET' })
  }
  const upstreamPort = typeof options.upstreamPort === 'function'
    ? options.upstreamPort
    : () => options.upstreamPort
  const resolveHarnessCookie = options.resolveHarnessCookie
  if (typeof resolveHarnessCookie !== 'function') {
    throw Object.assign(new Error('gateway requires resolveHarnessCookie'), { code: 'BAD_RESOLVER' })
  }

  const sign = (text) => createHmac('sha256', gateSecret).update(text).digest('base64url')
  const passwordHash = createHash('sha256').update(password, 'utf8').digest()
  const sessionTtlMs = Math.max(1, sessionHours) * 60 * 60 * 1000
  const cookieTtlMs = Math.min(sessionTtlMs, SESSION_COOKIE_TTL_MS)

  // ---- gate cookie -------------------------------------------------------

  function issueGateCookie() {
    const payload = Buffer.from(JSON.stringify({ iat: Date.now() }), 'utf8').toString('base64url')
    return `${payload}.${sign(payload)}`
  }

  function gateCookieValid(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false
    const dot = value.lastIndexOf('.')
    if (dot <= 0) return false
    const payload = value.slice(0, dot)
    const given = value.slice(dot + 1)
    const expected = sign(payload)
    if (given.length !== expected.length) return false
    if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return false
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      return typeof decoded?.iat === 'number' && Date.now() - decoded.iat < cookieTtlMs
    } catch {
      return false
    }
  }

  const gateOk = (req) => gateCookieValid(cookiesOf(req.headers).get(GATE_COOKIE))

  function passwordOk(value) {
    if (typeof value !== 'string' || value.length === 0) return false
    return constantTimeEqualString(
      createHash('sha256').update(value, 'utf8').digest('hex'),
      passwordHash.toString('hex'),
    )
  }

  // ---- login throttle ----------------------------------------------------

  const failures = new Map()

  function noteFailure(ip) {
    const now = Date.now()
    const rec = failures.get(ip) ?? { n: 0, first: now, until: 0 }
    if (now - rec.first > FAILURE_WINDOW_MS) {
      rec.n = 0
      rec.first = now
      rec.until = 0
    }
    rec.n += 1
    if (rec.n >= FAILURE_LIMIT) rec.until = now + BLOCK_MS
    // Bound the table so a scan cannot grow it without limit.
    if (failures.size > 1024) {
      const oldest = failures.keys().next().value
      if (oldest !== undefined) failures.delete(oldest)
    }
    failures.set(ip, rec)
  }

  const isBlocked = (ip) => {
    const rec = failures.get(ip)
    return rec !== undefined && rec.until > Date.now()
  }

  // ---- harness cookie cache ---------------------------------------------

  let cachedCookie = ''
  let cachedAt = 0
  let inflight

  async function harnessCookie({ force = false } = {}) {
    if (!force && cachedCookie.length > 0 && Date.now() - cachedAt < 60_000) return cachedCookie
    if (inflight !== undefined) return inflight
    const pending = (async () => {
      const value = await resolveHarnessCookie()
      if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error('harness returned an empty cookie'), { code: 'HARNESS_COOKIE_EMPTY' })
      }
      cachedCookie = value
      cachedAt = Date.now()
      return value
    })()
    inflight = pending
    try {
      return await pending
    } finally {
      if (inflight === pending) inflight = undefined
    }
  }

  /** Drop the cache so the next request re-mints (used after a 401). */
  function invalidateHarnessCookie() {
    cachedCookie = ''
    cachedAt = 0
  }

  // ---- header rewriting --------------------------------------------------

  function upstreamHeaders(req, cookie) {
    const authority = `127.0.0.1:${String(upstreamPort())}`
    const out = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) continue
      if (lower.startsWith('proxy-') || lower.startsWith('tailscale-user-')) continue
      out[lower] = value
    }
    out.host = authority
    // The harness session is injected here — the only reason a cookie-less
    // mobile WebSocket handshake works.
    out.cookie = cookie
    out.origin = `http://${authority}`
    out['x-forwarded-proto'] = 'https'
    return out
  }

  function filterResponseHeaders(headers) {
    const tokens = new Set(
      String(headers.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    )
    const out = {}
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'set-cookie' || lower === 'connection') continue
      if (HOP_BY_HOP.has(lower) || lower.startsWith('proxy-') || tokens.has(lower)) continue
      out[lower] = value
    }
    return out
  }

  // ---- responders --------------------------------------------------------

  function sendText(res, status, text) {
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }
    const body = Buffer.from(text, 'utf8')
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sendLogin(res, { failed = false, blocked = false, status = 200 } = {}) {
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }
    const body = Buffer.from(loginPage({ failed, blocked }), 'utf8')
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    })
    res.end(body)
  }

  function refuseUpgrade(socket, status, text) {
    const reason = status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'Bad Gateway'
    const body = Buffer.from(text, 'utf8')
    try {
      socket.write(
        `HTTP/1.1 ${String(status)} ${reason}\r\n`
        + `Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n`
        + `Content-Length: ${String(body.length)}\r\nCache-Control: no-store\r\n\r\n`,
      )
      socket.end(body)
    } catch {
      /* socket already gone */
    }
    try {
      socket.destroy()
    } catch {
      /* socket already gone */
    }
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        resolve(value)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        reject(error)
      }
      function onData(chunk) {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          fail(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
          return
        }
        chunks.push(chunk)
      }
      function onEnd() {
        done({ buffer: Buffer.concat(chunks) })
      }
      function onError(error) {
        fail(error)
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
    })
  }

  // ---- HTTP forwarding ---------------------------------------------------

  async function forwardHttp(req, res) {
    let cookie
    try {
      cookie = await harnessCookie()
    } catch (error) {
      sendText(res, 503, `harness 会话不可用：${String(error?.message ?? error)}\n`)
      return
    }

    let body
    try {
      body = req.method === 'GET' || req.method === 'HEAD' ? { buffer: Buffer.alloc(0) } : await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      sendText(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, 'bad request body\n')
      return
    }

    const attempt = (useCookie) => new Promise((resolve, reject) => {
      const upstream = http.request({
        host: '127.0.0.1',
        port: upstreamPort(),
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, useCookie),
      }, (upstreamRes) => resolve({ upstream, upstreamRes }))
      upstream.on('error', reject)
      if (body.buffer.length > 0) upstream.end(body.buffer)
      else upstream.end()
    })

    let result
    try {
      result = await attempt(cookie)
    } catch (error) {
      log('error', `stable-mobile: upstream request failed: ${String(error?.message ?? error)}`)
      sendText(res, 502, 'upstream unavailable\n')
      return
    }

    // A stale harness cookie (DSH restarted, session rotated) surfaces as 401.
    // Re-mint exactly once, then serve the retry.
    if (result.upstreamRes.statusCode === 401) {
      result.upstreamRes.resume()
      log('debug', 'stable-mobile: harness rejected the session cookie; re-minting once')
      try {
        const fresh = await harnessCookie({ force: true })
        result = await attempt(fresh)
      } catch (error) {
        log('error', `stable-mobile: cookie refresh failed: ${String(error?.message ?? error)}`)
        sendText(res, 502, 'upstream session unavailable\n')
        return
      }
    }

    const { upstreamRes } = result
    if (res.headersSent || res.writableEnded) {
      upstreamRes.resume()
      return
    }
    res.writeHead(upstreamRes.statusCode ?? 502, filterResponseHeaders(upstreamRes.headers))
    upstreamRes.on('error', () => {
      try {
        res.destroy()
      } catch {
        /* already gone */
      }
    })
    upstreamRes.pipe(res)
  }

  // ---- WebSocket upgrade -------------------------------------------------

  async function handleUpgrade(req, socket, head) {
    const path = (() => {
      try {
        return new URL(req.url ?? '/', 'http://local').pathname
      } catch {
        return '/'
      }
    })()
    if (path === HEALTH_PATH || path === LOGIN_PATH) {
      refuseUpgrade(socket, 400, 'not an upgrade target\n')
      return
    }

    if (!gateOk(req)) {
      refuseUpgrade(socket, 401, 'login required\n')
      return
    }

    let cookie
    try {
      cookie = await harnessCookie()
    } catch (error) {
      refuseUpgrade(socket, 503, `harness session unavailable: ${String(error?.message ?? error)}\n`)
      return
    }

    const headers = upstreamHeaders(req, cookie)
    const lines = [`GET ${req.url ?? '/'} HTTP/1.1`]
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
      else lines.push(`${key}: ${String(value)}`)
    }
    // The hop-by-hop filter removed these; a WebSocket handshake needs them back.
    lines.push('connection: Upgrade')
    lines.push(`upgrade: ${headerValue(req.headers, 'upgrade') ?? 'websocket'}`)
    lines.push('', '')

    const upstream = net.connect(upstreamPort(), '127.0.0.1')
    let handshakeDone = false

    const teardown = () => {
      try {
        upstream.destroy()
      } catch {
        /* gone */
      }
      try {
        socket.destroy()
      } catch {
        /* gone */
      }
    }

    upstream.once('connect', () => {
      upstream.write(lines.join('\r\n'))
      if (head !== undefined && head.length > 0) upstream.write(head)
    })
    upstream.on('error', (error) => {
      if (!handshakeDone) {
        handshakeDone = true
        log('error', `stable-mobile: upgrade upstream failed: ${String(error?.message ?? error)}`)
        refuseUpgrade(socket, 502, 'upstream unavailable\n')
      } else {
        teardown()
      }
    })
    socket.on('error', teardown)
    socket.on('close', () => {
      try {
        upstream.destroy()
      } catch {
        /* gone */
      }
    })
    upstream.on('close', () => {
      try {
        socket.destroy()
      } catch {
        /* gone */
      }
    })

    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffer.length > MAX_HEAD_BYTES) {
          upstream.off('data', onData)
          handshakeDone = true
          teardown()
        }
        return
      }
      upstream.off('data', onData)
      handshakeDone = true

      const headBuffer = buffer.subarray(0, end + 4)
      const rest = buffer.subarray(end + 4)
      const status = Number.parseInt(headBuffer.toString('latin1').split(' ')[1] ?? '', 10)

      // Never leak a Set-Cookie to the phone: it holds no harness credential.
      const rewritten = headBuffer.toString('latin1')
        .split('\r\n')
        .filter((line) => !/^set-cookie:/i.test(line))
        .join('\r\n')

      if (socket.destroyed) {
        try {
          upstream.destroy()
        } catch {
          /* gone */
        }
        return
      }

      socket.write(rewritten)
      if (rest.length > 0) socket.write(rest)

      if (status !== 101) {
        log('warn', `stable-mobile: harness refused the upgrade (HTTP ${String(status)}) for ${path}`)
        // The session may have rotated under us; refresh so the next retry works.
        invalidateHarnessCookie()
        upstream.pipe(socket)
        upstream.once('end', () => {
          try {
            socket.end()
          } catch {
            /* gone */
          }
        })
        return
      }

      upstream.pipe(socket)
      socket.pipe(upstream)
    }
    upstream.on('data', onData)
  }

  // ---- server ------------------------------------------------------------

  const server = http.createServer((req, res) => {
    void (async () => {
      let pathname = '/'
      try {
        pathname = new URL(req.url ?? '/', 'http://local').pathname
      } catch {
        /* keep default */
      }

      if (pathname === HEALTH_PATH) {
        sendText(res, 200, 'ok\n')
        return
      }

      if (pathname === LOGIN_PATH) {
        const ip = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
        if (req.method === 'POST') {
          if (isBlocked(ip)) {
            sendLogin(res, { blocked: true, status: 429 })
            return
          }
          let body
          try {
            body = await readBody(req, MAX_LOGIN_BODY)
          } catch {
            sendText(res, 400, 'bad login request\n')
            return
          }
          const supplied = new URLSearchParams(body.buffer.toString('utf8')).get('p') ?? ''
          if (passwordOk(supplied)) {
            failures.delete(ip)
            log('info', `stable-mobile: session issued for ${ip}`)
            res.writeHead(303, {
              'set-cookie': `${GATE_COOKIE}=${issueGateCookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(cookieTtlMs / 1000))}`,
              location: '/',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            res.end()
            return
          }
          noteFailure(ip)
          log('warn', `stable-mobile: failed login from ${ip}`)
          sendLogin(res, { failed: true, status: 401 })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendLogin(res)
          return
        }
        sendText(res, 405, 'method not allowed\n')
        return
      }

      if (!gateOk(req)) {
        sendLogin(res)
        return
      }

      await forwardHttp(req, res)
    })().catch((error) => {
      log('error', `stable-mobile: request failed: ${String(error?.stack ?? error)}`)
      if (!res.headersSent) sendText(res, 502, 'gateway error\n')
      else res.destroy()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      log('error', `stable-mobile: upgrade failed: ${String(error?.stack ?? error)}`)
      refuseUpgrade(socket, 502, 'gateway error\n')
    })
  })

  server.on('clientError', (error, socket) => {
    log('debug', `stable-mobile: client error: ${String(error?.message ?? error)}`)
    try {
      socket.destroy()
    } catch {
      /* gone */
    }
  })

  server.on('error', (error) => {
    log('error', `stable-mobile: gateway listen error: ${String(error?.message ?? error)}`)
  })

  // ---- lifecycle ---------------------------------------------------------

  const listen = () => new Promise((resolve, reject) => {
    if (server.listening) {
      resolve({ port, host: '127.0.0.1' })
      return
    }
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve({ port, host: '127.0.0.1' })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  const close = () => new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    try {
      server.close(() => resolve())
      server.closeAllConnections?.()
    } catch {
      resolve()
    }
  })

  const status = () => ({
    listening: server.listening === true,
    port,
    harnessCookieCached: cachedCookie.length > 0,
  })

  return { listen, close, status, invalidateHarnessCookie, LOGIN_PATH, HEALTH_PATH }
}
