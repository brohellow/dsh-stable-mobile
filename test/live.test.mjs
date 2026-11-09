/**
 * Live integration test against the RUNNING dsh instance.
 *
 * Uses the real harness endpoints (the same ones ctx.connection.authenticatedUrl
 * produces) to prove the plugin's resolveHarnessCookie path yields a cookie the
 * running harness accepts — including on the WebSocket upgrade, which is where
 * MiuiBrowser fails.
 *
 * No DSH restart is involved: the running GUI on :57765 is untouched.
 */
import net from 'node:net'
import { createGateway } from '../lib/gateway.js'

const DSH_PORT = Number(process.env.DSH_TEST_PORT ?? 57765)
const GATE_PORT = 59011
const PASSWORD = 'live-test-pw'
const SECRET = 'live-test-gate-secret-abcdef'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Exactly what ctx.connection.authenticatedUrl does: obtain a token then a cookie. */
async function mintHarnessCookie() {
  const response = await fetch(`http://127.0.0.1:${DSH_PORT}/remote-access/info`, {
    signal: AbortSignal.timeout(5000),
  })
  const info = await response.json()
  const token = new URL(info.url).searchParams.get('token')
  const auth = await fetch(
    `http://127.0.0.1:${DSH_PORT}/?token=${encodeURIComponent(token)}`,
    { redirect: 'manual', signal: AbortSignal.timeout(5000) },
  )
  const list = auth.headers.getSetCookie()
  const found = list.find((c) => c.startsWith('dsh-auth-'))
  if (found === undefined) throw new Error(`no harness cookie (HTTP ${auth.status})`)
  return found.split(';')[0]
}

const gateway = createGateway({
  password: PASSWORD,
  gateSecret: SECRET,
  port: GATE_PORT,
  upstreamPort: () => DSH_PORT,
  resolveHarnessCookie: mintHarnessCookie,
  log: () => {},
})
await gateway.listen()

const BASE = `http://127.0.0.1:${GATE_PORT}`

// login
let gateCookie = ''
{
  const r = await fetch(`${BASE}/__stable/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `p=${PASSWORD}`,
    redirect: 'manual',
  })
  gateCookie = (r.headers.getSetCookie()[0] ?? '').split(';')[0]
  check('password login issues a gate cookie', r.status === 303 && gateCookie.includes('dsh_stable_gate'))
}

// real page through the gateway
{
  const r = await fetch(`${BASE}/`, { headers: { cookie: gateCookie } })
  const body = await r.text()
  check('real DSH page proxies through the gateway', r.status === 200 && body.includes('__DSH'))
  check('page is the real app shell', body.length > 10000, `${body.length} bytes`)
}

// real API call
{
  const r = await fetch(`${BASE}/api/agentPresets/list`, {
    method: 'POST',
    headers: { cookie: gateCookie, 'content-type': 'application/json' },
    body: '{}',
  })
  const text = await r.text()
  check('real API call reaches the harness', r.status === 200 && !text.includes('authentication required'), `HTTP ${r.status}`)
}

// the decisive test: WebSocket upgrade with ONLY the gate cookie
{
  const result = await new Promise((resolve) => {
    const socket = net.connect(GATE_PORT, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${GATE_PORT}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        + 'User-Agent: Mozilla/5.0 (Linux; Android 16) XiaoMi/MiuiBrowser/20.28\r\n'
        + `Cookie: ${gateCookie}\r\n\r\n`,
      )
    })
    socket.setTimeout(8000, () => { socket.destroy(); resolve('timeout') })
    socket.once('data', (chunk) => {
      resolve(chunk.toString('latin1').split('\r\n')[0])
      socket.destroy()
    })
    socket.on('error', (e) => resolve(`error:${e.message}`))
  })
  check('MiuiBrowser-style WS upgrade reaches the real harness (101)', result.includes('101'), result)
}

await gateway.close()
console.log(failures.length === 0 ? '\nLIVE INTEGRATION PASSED' : `\nLIVE FAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
