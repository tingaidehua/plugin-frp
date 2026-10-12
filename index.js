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
} from './lib/frp-ops.js'
import { loadCredentials } from './lib/credentials.js'
import { registerJsonTool } from './lib/register-json-tool.js'

export const name = 'plugin-frp'
export const inject = ['tools']

export function apply(ctx) {
  registerJsonTool(ctx, {
    name: 'frp_configure',
    description:
      'Save FRP_SERVER_ADDR / FRP_TOKEN / FRP_PUBLIC_BASE from the user into ~/.env and ~/.config/plugin-frp/credentials.env. Never hardcode server IP in source — always ask.',
    parameters: {
      type: 'object',
      properties: {
        FRP_SERVER_ADDR: { type: 'string', description: 'frps host or IP (user-provided)' },
        FRP_SERVER_PORT: { type: 'number' },
        FRP_TOKEN: { type: 'string' },
        FRP_PUBLIC_BASE: { type: 'string', description: 'optional https://domain for ops APIs' },
        FRP_CLIENT_ID: { type: 'string' },
      },
      additionalProperties: false,
    },
    execute: async (args) => configureFrp(args || {}),
  })

  registerJsonTool(ctx, {
    name: 'frp_status',
    description: 'Show frps/frpc status + whether credentials are configured (not the secret values).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
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
  })

  registerJsonTool(ctx, {
    name: 'frp_install_server',
    description: 'Install frps+systemd only if no existing toml. Never overwrites token unless force=true.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Dangerous: overwrite existing frps.toml' },
      },
      additionalProperties: false,
    },
    execute: async ({ force = false } = {}) => installServer({ force }),
  })

  registerJsonTool(ctx, {
    name: 'frp_install_client',
    description: 'Copy vendor frpc into ~/.config/plugin-frp (isolated from other frpc installs).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => installClient(),
  })

  registerJsonTool(ctx, {
    name: 'frp_write_client_config',
    description: 'Write frpc.toml using FRP_SERVER_ADDR from frp_configure (or args). Prefer frp_connect_egress for sticky ports.',
    parameters: {
      type: 'object',
      properties: {
        serverAddr: { type: 'string' },
        serverPort: { type: 'number' },
        localIp: { type: 'string' },
        localPort: { type: 'number' },
        remotePort: { type: 'number' },
        proxyName: { type: 'string' },
      },
      additionalProperties: false,
    },
    execute: async (args) => writeClientConfig(args),
  })

  registerJsonTool(ctx, {
    name: 'frp_connect_egress',
    description:
      'Map a local port (default 22) to a sticky remote allowPort via shared SQLite (plugin-ops-store), start frpc, enable reboot autostart. Ask user for FRP_SERVER_ADDR first via frp_configure.',
    parameters: {
      type: 'object',
      properties: {
        localPort: { type: 'number', description: 'default 22 for SSH egress' },
        localIp: { type: 'string' },
        clientId: { type: 'string' },
        remotePort: { type: 'number', description: 'optional override; else sticky alloc' },
        autostart: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    execute: async (args) => connectEgress(args || {}),
  })

  registerJsonTool(ctx, {
    name: 'frp_disconnect',
    description: 'Default disconnect: stop plugin-frpc. Keeps sticky remote port unless forgetPort=true.',
    parameters: {
      type: 'object',
      properties: {
        localPort: { type: 'number' },
        clientId: { type: 'string' },
        forgetPort: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    execute: async (args) => disconnectEgress(args || {}),
  })

  registerJsonTool(ctx, {
    name: 'frp_enable_autostart',
    description: 'Enable systemd (Linux) or Scheduled Task (Windows) so frpc restarts after reboot.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => enableClientAutostart(),
  })

  registerJsonTool(ctx, {
    name: 'frp_start_client',
    description: 'Start background frpc using ~/.config/plugin-frp/frpc.toml (prefer frp_connect_egress).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => startClientBackground(),
  })

  registerJsonTool(ctx, {
    name: 'frp_list_online',
    description: 'Detect frpc connections on frps: listening 60xxx ports + sync lease online flags in SQLite.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => listOnlineProxies(),
  })

  registerJsonTool(ctx, {
    name: 'frp_stop_client',
    description: 'Stop frpc processes started from ~/.config/plugin-frp (does not touch other frpc installs).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => stopClientBackground(),
  })

  console.log('[plugin-frp] tools registered')
}
