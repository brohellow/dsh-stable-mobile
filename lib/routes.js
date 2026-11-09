/**
 * dsh-stable-mobile — host HTTP surface (lib/routes.js).
 *
 * Loopback-only routes used by the 手机访问 settings page:
 *
 *   GET  /stable-mobile/status.json   current state + effective config
 *   POST /stable-mobile/action        start / stop / restart / rotate-password
 *   POST /stable-mobile/set           patch config fields
 *
 * Mutating actions require a non-simple header so an arbitrary web page cannot
 * drive them (CSRF). Every route refuses non-loopback peers: the phone reaches
 * them through the plugin's own gateway, which proxies from loopback.
 */

export const ROUTE_PREFIX = '/stable-mobile'
export const STATUS_PATH = `${ROUTE_PREFIX}/status.json`
export const ACTION_PATH = `${ROUTE_PREFIX}/action`
export const HEALTH_PATH = `${ROUTE_PREFIX}/health`

const ACTION_HEADER = 'x-stable-mobile-action'
const MAX_BODY_BYTES = 8192

function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

function sendJson(res, status, body) {
  if (res.headersSent) return
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register the plugin's host routes.
 *
 * @param ctx - plugin context carrying `webServer`.
 * @param api - `{ status, start, stop, restart, rotatePassword, set, reset }`.
 * @returns disposer for the route registration.
 */
export function registerRoutes(ctx, api, { log = () => {} } = {}) {
  const handler = async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      log('warn', `stable-mobile: refused ${String(req.socket?.remoteAddress)} on a loopback-only route`)
      sendJson(res, 403, { ok: false, error: 'loopback clients only' })
      return
    }

    const url = new URL(req.url ?? '/', 'http://dsh.invalid')

    if (url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      try {
        sendJson(res, 200, await api.status())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    if (url.pathname === ACTION_PATH) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      if (req.headers[ACTION_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: `missing ${ACTION_HEADER} header` })
        return
      }
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        sendJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
          ok: false,
          error: String(error?.message ?? error),
        })
        return
      }
      try {
        switch (body.action) {
          case 'start':
            await api.start()
            sendJson(res, 200, { ok: true, result: { started: true } })
            return
          case 'stop':
            await api.stop()
            sendJson(res, 200, { ok: true, result: { stopped: true } })
            return
          case 'restart':
            await api.restart()
            sendJson(res, 200, { ok: true, result: { restarted: true } })
            return
          case 'rotate-password': {
            const result = await api.rotatePassword()
            sendJson(res, 200, { ok: true, result })
            return
          }
          case 'set': {
            if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
              sendJson(res, 400, { ok: false, error: 'set needs a plain-object patch' })
              return
            }
            sendJson(res, 200, { ok: true, result: { config: await api.set(body.patch) } })
            return
          }
          case 'reset': {
            sendJson(res, 200, { ok: true, result: { config: await api.reset() } })
            return
          }
          default:
            sendJson(res, 400, { ok: false, error: `unknown action ${JSON.stringify(body.action)}` })
            return
        }
      } catch (error) {
        const code = String(error?.code ?? '')
        const clientFault = code.startsWith('BAD_') || code === 'UNKNOWN_FIELD'
        log(clientFault ? 'warn' : 'error', `stable-mobile: action failed: ${String(error)}`)
        sendJson(res, clientFault ? 400 : 500, {
          ok: false,
          error: String(error?.message ?? error),
          ...(code.length === 0 ? {} : { code }),
        })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
