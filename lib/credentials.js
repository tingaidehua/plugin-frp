import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clientConfigDir, ensureDir } from './paths.js'

const ENV_KEYS = [
  'FRP_SERVER_ADDR',
  'FRP_SERVER_PORT',
  'FRP_TOKEN',
  'FRP_PUBLIC_BASE',
  'FRP_DASHBOARD_USER',
  'FRP_DASHBOARD_PASSWORD',
  'FRP_CLIENT_ID',
]

export function homeEnvPath() {
  return path.join(os.homedir(), '.env')
}

export function credentialsPath() {
  return path.join(clientConfigDir(), 'credentials.env')
}

function parseEnvFile(filePath) {
  const out = {}
  if (!fs.existsSync(filePath)) return out
  const text = fs.readFileSync(filePath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function upsertEnvFile(filePath, updates) {
  ensureDir(path.dirname(filePath))
  const existing = parseEnvFile(filePath)
  const merged = { ...existing, ...updates }
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') delete merged[k]
  }
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n') + '\n'
  fs.writeFileSync(filePath, body, { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* win */
  }
  return merged
}

/** Load FRP_* from process.env, then credentials.env, then ~/.env. Never hardcode server IP. */
export function loadCredentials() {
  const fromCred = parseEnvFile(credentialsPath())
  const fromHome = parseEnvFile(homeEnvPath())
  const out = {}
  for (const k of ENV_KEYS) {
    out[k] = process.env[k] || fromCred[k] || fromHome[k] || ''
  }
  if (!out.FRP_SERVER_PORT) out.FRP_SERVER_PORT = '7000'
  if (!out.FRP_CLIENT_ID) {
    out.FRP_CLIENT_ID = `${os.hostname()}-${process.platform}`.replace(/[^a-zA-Z0-9._-]/g, '-')
  }
  return out
}

/**
 * Persist credentials. FRP_SERVER_ADDR / FRP_TOKEN must come from the user — never from source.
 * Writes ~/.config/plugin-frp/credentials.env and merges into ~/.env (FRP_* only).
 */
export function saveCredentials(partial = {}) {
  const clean = {}
  for (const k of ENV_KEYS) {
    if (partial[k] !== undefined && partial[k] !== null && String(partial[k]).trim() !== '') {
      clean[k] = String(partial[k]).trim()
    }
  }
  // Never ship default server addresses in source — only persist what the user provided.
  const credMerged = upsertEnvFile(credentialsPath(), clean)
  const homeMerged = upsertEnvFile(homeEnvPath(), clean)
  for (const [k, v] of Object.entries(clean)) {
    process.env[k] = v
  }
  return {
    ok: true,
    credentialsPath: credentialsPath(),
    homeEnvPath: homeEnvPath(),
    savedKeys: Object.keys(clean),
    present: {
      FRP_SERVER_ADDR: Boolean(credMerged.FRP_SERVER_ADDR || homeMerged.FRP_SERVER_ADDR),
      FRP_TOKEN: Boolean(credMerged.FRP_TOKEN || homeMerged.FRP_TOKEN),
      FRP_PUBLIC_BASE: Boolean(credMerged.FRP_PUBLIC_BASE || homeMerged.FRP_PUBLIC_BASE),
      FRP_CLIENT_ID: credMerged.FRP_CLIENT_ID || homeMerged.FRP_CLIENT_ID || '',
    },
    note: 'Ask the human for FRP_SERVER_ADDR and FRP_TOKEN; never embed them in plugin source.',
  }
}

export function requireServerAddr(creds = loadCredentials()) {
  if (!creds.FRP_SERVER_ADDR) {
    return {
      ok: false,
      error: 'FRP_SERVER_ADDR missing. Ask the user for the frps host/IP, then call frp_configure.',
      needFromUser: ['FRP_SERVER_ADDR', 'FRP_TOKEN'],
    }
  }
  if (!creds.FRP_TOKEN) {
    return {
      ok: false,
      error: 'FRP_TOKEN missing. Ask the user for the shared token, then call frp_configure.',
      needFromUser: ['FRP_TOKEN'],
    }
  }
  return { ok: true, creds }
}
