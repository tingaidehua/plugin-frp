#!/usr/bin/env node
/**
 * Cross-runtime CLI for Hermes/other agents.
 * Usage: node bin/invoke.mjs <toolName> '<json-args>'
 */
import {
  frpStatus,
  installServer,
  installClient,
  writeClientConfig,
  startClientBackground,
  listOnlineProxies,
  stopClientBackground,
  configureFrp,
  connectEgress,
  disconnectEgress,
  enableClientAutostart,
} from '../lib/frp-ops.js'
import { loadCredentials } from '../lib/credentials.js'

const tools = {
  frp_configure: (a) => configureFrp(a),
  frp_status: async () => {
    const creds = loadCredentials()
    return {
      ...frpStatus(),
      credentials: {
        FRP_SERVER_ADDR: Boolean(creds.FRP_SERVER_ADDR),
        FRP_TOKEN: Boolean(creds.FRP_TOKEN),
        FRP_PUBLIC_BASE: Boolean(creds.FRP_PUBLIC_BASE),
        FRP_CLIENT_ID: creds.FRP_CLIENT_ID || '',
      },
    }
  },
  frp_install_server: (a) => installServer(a || {}),
  frp_install_client: () => installClient(),
  frp_write_client_config: (a) => writeClientConfig(a || {}),
  frp_connect_egress: (a) => connectEgress(a || {}),
  frp_disconnect: (a) => disconnectEgress(a || {}),
  frp_enable_autostart: () => enableClientAutostart(),
  frp_start_client: () => startClientBackground(),
  frp_list_online: () => listOnlineProxies(),
  frp_stop_client: () => stopClientBackground(),
}

const name = process.argv[2]
const raw = process.argv[3] || '{}'
if (!name || !tools[name]) {
  console.log(JSON.stringify({ ok: false, error: `unknown tool ${name}`, tools: Object.keys(tools) }))
  process.exit(2)
}
let args = {}
try {
  args = JSON.parse(raw)
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: `bad json args: ${e.message}` }))
  process.exit(2)
}
try {
  const out = await tools[name](args)
  console.log(typeof out === 'string' ? out : JSON.stringify(out))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.stack || e) }))
  process.exit(1)
}
