/**
 * Integration test for dsh-stable-mobile's gateway.
 *
 * Boots the real gateway module against a stand-in upstream that mimics the
 * harness: it 401s without its own cookie and 101s an upgrade only when the
 * cookie is present. That reproduces the MiuiBrowser failure exactly, so the
 * test proves the injection path works.
 */
import http from 'node:http'
import net from 'node:net'
import { createHmac } from 'node:crypto'
import { createGateway, GATE_COOKIE } from '../lib/gateway.js'

const HARNESS_COOKIE = 'dsh-auth-test=v1.signed.deadbeef'
const PASSWORD = 'testpass1234'
const SECRET = 'test-gate-secret-0123456789'
const UPSTREAM_PORT = 59001
const GATE_PORT = 59002

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// ---- stand-in harness -------------------------------------------------------
const upstream = http.createServer((req, res) => {
  const cookie = req.headers.cookie ?? ''
  if (!cookie.includes(HARNESS_COOKIE.split('=')[0] + '=')) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('harness: auth required')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html>__DSH_BOOT__</html>')
})

upstream.on('upgrade', (req, socket) => {
  const cookie = req.headers.cookie ?? ''
  if (!cookie.includes(HARNESS_COOKIE)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
})

await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))

// ---- gateway ----------------------------------------------------------------
let mintCount = 0
const gateway = createGateway({
  password: PASSWORD,
  gateSecret: SECRET,
  port: GATE_PORT,
  sessionHours: 720,
  upstreamPort: () => UPSTREAM_PORT,
  resolveHarnessCookie: async () => {
    mintCount += 1
    return HARNESS_COOKIE
  },
  log: () => {},
})
await gateway.listen()

const BASE = `http://127.0.0.1:${GATE_PORT}`

// 1) unauthenticated GET -> login page
{
  const r = await fetch(`${BASE}/`)
  const body = await r.text()
  check('unauthenticated request served the login page', r.status === 200 && body.includes('访问密码'))
}

// 2) wrong password -> 401
{
  const r = await fetch(`${BASE}/__stable/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'p=wrong',
    redirect: 'manual',
  })
  check('wrong password rejected', r.status === 401)
}

// 3) correct password -> 303 + gate cookie
let gateCookie = ''
{
  const r = await fetch(`${BASE}/__stable/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `p=${PASSWORD}`,
    redirect: 'manual',
  })
  const setCookie = r.headers.getSetCookie()
  gateCookie = (setCookie[0] ?? '').split(';')[0]
  check('correct password issues a 30-day gate cookie',
    r.status === 303 && gateCookie.startsWith(`${GATE_COOKIE}=`),
    `status=${r.status}`)
  check('gate cookie is HttpOnly and long-lived',
    setCookie[0].includes('HttpOnly') && setCookie[0].includes('Max-Age=2592000'))
}

// 4) page with ONLY the gate cookie -> 200 (harness cookie injected server-side)
{
  const r = await fetch(`${BASE}/`, { headers: { cookie: gateCookie } })
  const body = await r.text()
  check('gate cookie alone yields the harness page (cookie injected)', r.status === 200 && body.includes('__DSH_BOOT__'))
}

// 5) the harness cookie never leaks to the client
{
  const r = await fetch(`${BASE}/`, { headers: { cookie: gateCookie } })
  const leaked = r.headers.getSetCookie().some((c) => c.startsWith('dsh-auth-'))
  check('harness cookie is never sent to the browser', leaked === false)
}

// 6) WebSocket with ONLY the gate cookie -> 101  ← the MiuiBrowser case
{
  const result = await new Promise((resolve) => {
    const socket = net.connect(GATE_PORT, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${GATE_PORT}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        + `Cookie: ${gateCookie}\r\n\r\n`,
      )
    })
    socket.setTimeout(4000, () => { socket.destroy(); resolve('timeout') })
    socket.once('data', (chunk) => {
      resolve(chunk.toString('latin1').split('\r\n')[0])
      socket.destroy()
    })
    socket.on('error', () => resolve('error'))
  })
  check('gate cookie alone completes the WebSocket upgrade (cookie injected)', result.includes('101'), result)
}

// 7) WebSocket without any cookie -> 401
{
  const result = await new Promise((resolve) => {
    const socket = net.connect(GATE_PORT, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${GATE_PORT}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.setTimeout(4000, () => { socket.destroy(); resolve('timeout') })
    socket.once('data', (chunk) => {
      resolve(chunk.toString('latin1').split('\r\n')[0])
      socket.destroy()
    })
    socket.on('error', () => resolve('error'))
  })
  check('WebSocket without a gate cookie is refused', result.includes('401'), result)
}

// 8) health endpoint needs no credential
{
  const r = await fetch(`${BASE}/__stable/health`)
  check('health endpoint is open', r.status === 200)
}

// 9) session cookie is cached, not minted per request
{
  const before = mintCount
  await fetch(`${BASE}/`, { headers: { cookie: gateCookie } })
  await fetch(`${BASE}/`, { headers: { cookie: gateCookie } })
  check('harness cookie is cached across requests', mintCount === before, `mints=${String(mintCount)}`)
}

await gateway.close()
// The harness stand-in keeps keep-alive sockets open, so close() would never
// fire its callback. Destroy them outright; this is a test-only teardown.
upstream.closeAllConnections?.()
upstream.close()
await new Promise((resolve) => setTimeout(resolve, 50))

console.log(failures === 0 ? '\nALL GATEWAY TESTS PASSED' : `\nFAILURES: ${String(failures)}`)
process.exit(failures === 0 ? 0 : 1)
