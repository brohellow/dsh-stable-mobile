/**
 * Durable, owner-only plugin state for dsh-stable-mobile.
 *
 *   $DSH_HOME/stable-mobile.json
 *   {
 *     version: 1,
 *     password:   "<access password shown on the phone login page>",
 *     gateSecret: "<HMAC key signing the browser gate cookie>",
 *     config:     { enabled, publicUrl, ... }   // card-edited overrides
 *   }
 *
 * Both secrets are generated once and then reused, which is what makes the
 * public URL and the access password stable across DSH restarts and plugin
 * upgrades — unlike a per-process pairing token.
 *
 * Writes are atomic (temp file + rename, 0600) and failures are reported rather
 * than swallowed: a secret that silently failed to persist would log every
 * paired phone out on the next start.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const STATE_VERSION = 1

/** 32 random bytes, base64url — safe in a URL and in a cookie. */
export function mintSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * A short, human-typeable password: unambiguous alphabet, no look-alike pairs.
 * Nine characters over a 31-symbol alphabet is ~44 bits — plenty against the
 * login throttle in the gateway, and still easy to type on a phone.
 */
export function mintPassword(length = 9) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const raw = randomBytes(length * 2)
  let out = ''
  for (let i = 0; out.length < length; i += 1) {
    // Rejection sampling keeps the distribution flat.
    const byte = raw[i % raw.length]
    if (byte >= 248) continue
    out += alphabet[byte % alphabet.length]
  }
  return out
}

export function statePath(home) {
  const base = String(home).replace(/[\\/]+$/, '')
  return `${base}/stable-mobile.json`
}

/**
 * Read the state file without creating anything.
 * A missing or corrupt file yields an empty record; the caller mints secrets
 * and writes them back.
 */
export async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return {
      password: typeof parsed?.password === 'string' && parsed.password.length >= 6 ? parsed.password : undefined,
      gateSecret: typeof parsed?.gateSecret === 'string' && parsed.gateSecret.length >= 16 ? parsed.gateSecret : undefined,
      config: parsed?.config !== null && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
        ? parsed.config
        : {},
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { corrupt: String(error?.message ?? error), config: {} }
    }
    return { config: {} }
  }
}

/** Atomically persist the whole record. */
export async function writeState(file, record) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = {
    version: STATE_VERSION,
    password: record.password,
    gateSecret: record.gateSecret,
    config: record.config ?? {},
  }
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
  return payload
}
