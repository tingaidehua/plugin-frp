/** Lazy import of shared plugin-ops-store (sibling install). */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_ROOT } from './paths.js'

let _store = null

export async function getOpsStore() {
  if (_store) return _store
  const roots = [
    process.env.PLUGIN_OPS_STORE_DIR,
    process.env.DSH_OPS_STORE_DIR,
    '/opt/plugin-ops/plugin-ops-store',
    '/opt/agent-plugins/plugin-ops-store',
    '/opt/agent-plugins/dsh-ops-store',
    path.resolve(PLUGIN_ROOT, '../plugin-ops-store'),
    path.resolve(PLUGIN_ROOT, '../dsh-ops-store'),
  ].filter(Boolean)
  for (const root of roots) {
    const entry = path.join(root, 'index.js')
    const pkg = path.join(root, 'package.json')
    if (!fs.existsSync(entry) || !fs.existsSync(pkg)) continue
    try {
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name !== 'plugin-ops-store') continue
    } catch {
      continue
    }
    _store = await import(pathToFileURL(entry).href)
    return _store
  }
  return null
}

export async function withOpsStore(fn, fallback) {
  const store = await getOpsStore()
  if (!store) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
  return fn(store)
}
