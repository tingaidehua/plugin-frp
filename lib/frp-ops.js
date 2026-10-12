import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  clientConfigDir,
  ensureDir,
  serverFrpsToml,
  vendorBinary,
} from './paths.js'
import { loadCredentials, requireServerAddr, saveCredentials } from './credentials.js'
import { withOpsStore } from './ops-store.js'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  })
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message) : '',
  }
}

export function frpStatus() {
  const toml = serverFrpsToml()
  const exists = fs.existsSync(toml)
  let tokenSet = false
  let bindPort = null
  let portRange = null
  if (exists) {
    const text = fs.readFileSync(toml, 'utf8')
    tokenSet = /auth\.token\s*=\s*"[^"]+"/.test(text)
    const m = text.match(/bindPort\s*=\s*(\d+)/)
    if (m) bindPort = Number(m[1])
    const a = text.match(/start\s*=\s*(\d+)/)
    const b = text.match(/end\s*=\s*(\d+)/)
    if (a && b) portRange = `${a[1]}-${b[1]}`
  }
  const unit = run('systemctl', ['is-active', 'frps'])
  const listen = run('bash', ['-lc', "ss -tlnp | grep -E ':(7000|7500)\\s' || true"])
  const clientDir = clientConfigDir()
  return {
    mode: exists ? 'adopt-existing' : 'not-installed',
    frpsToml: toml,
    frpsTomlExists: exists,
    tokenPresent: tokenSet,
    bindPort,
    portRange,
    systemd: unit.stdout || unit.stderr || unit.error || 'n/a',
    listen: listen.stdout,
    clientConfigDir: clientDir,
    clientConfigExists: fs.existsSync(path.join(clientDir, 'frpc.toml')),
    note: 'Existing /etc/frp/frps.toml is never overwritten by install_server when present.',
  }
}

export function installServer({ force = false } = {}) {
  const toml = serverFrpsToml()
  if (fs.existsSync(toml) && !force) {
    return {
      ok: true,
      action: 'adopted',
      message: `Found ${toml}; left untouched (use force=true only on empty hosts).`,
      status: frpStatus(),
    }
  }
  const bin = vendorBinary('frps')
  if (!fs.existsSync(bin)) {
    return { ok: false, error: `missing vendor binary: ${bin}` }
  }
  ensureDir(path.dirname(toml))
  const token = process.env.FRP_TOKEN
  if (!token) {
    return { ok: false, error: 'FRP_TOKEN required in env for fresh install' }
  }
  const body = [
    'bindPort = 7000',
    'auth.method = "token"',
    `auth.token = "${token}"`,
    'allowPorts = [',
    '  { start = 60000, end = 60100 }',
    ']',
    'webServer.addr = "127.0.0.1"',
    'webServer.port = 7500',
    `webServer.user = "${process.env.FRP_DASHBOARD_USER || 'admin'}"`,
    `webServer.password = "${process.env.FRP_DASHBOARD_PASSWORD || 'change-me'}"`,
    '',
  ].join('\n')
  fs.writeFileSync(toml, body, { mode: 0o600 })
  fs.copyFileSync(bin, '/usr/local/bin/frps')
  fs.chmodSync('/usr/local/bin/frps', 0o755)
  const unit = `[Unit]
Description=frp server (plugin-frp)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c ${toml}
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
  fs.writeFileSync('/etc/systemd/system/frps.service', unit)
  run('systemctl', ['daemon-reload'])
  run('systemctl', ['enable', '--now', 'frps'])
  return { ok: true, action: 'installed', status: frpStatus() }
}

export function installClient() {
  const dir = ensureDir(clientConfigDir())
  const binSrc = vendorBinary('frpc')
  if (!fs.existsSync(binSrc)) {
    return { ok: false, error: `missing vendor binary: ${binSrc}` }
  }
  const dest = path.join(dir, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  fs.copyFileSync(binSrc, dest)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
  return { ok: true, frpcPath: dest, configDir: dir }
}

export async function configureFrp(partial = {}) {
  const saved = saveCredentials(partial)
  return withOpsStore(async (store) => {
    if (saved.present.FRP_SERVER_ADDR && saved.present.FRP_TOKEN) {
      store.kvSet('frp', 'credentials_configured', '1')
      store.audit('plugin-frp', 'configure', 'credentials_saved')
      try {
        store.notifyPush({
          level: 'info',
          title: 'frp credentials configured',
          body: 'FRP_SERVER_ADDR/TOKEN saved to env paths (not SQLite)',
          source: 'plugin-frp',
        })
      } catch { /* optional */ }
    }
    return { ...saved, opsDb: store.storeStatus() }
  }, saved)
}

export function writeClientConfig({
  serverAddr,
  serverPort,
  localIp = '127.0.0.1',
  localPort = 22,
  remotePort,
  proxyName,
} = {}) {
  const creds = loadCredentials()
  const token = creds.FRP_TOKEN || process.env.FRP_TOKEN
  serverAddr = serverAddr || creds.FRP_SERVER_ADDR
  serverPort = Number(serverPort || creds.FRP_SERVER_PORT || 7000)
  if (!token) return { ok: false, error: 'FRP_TOKEN missing — ask user, then frp_configure' }
  if (!serverAddr) {
    return {
      ok: false,
      error: 'FRP_SERVER_ADDR missing — ask user for frps host/IP, then frp_configure (never hardcode in source)',
      needFromUser: ['FRP_SERVER_ADDR', 'FRP_TOKEN'],
    }
  }
  if (!remotePort) return { ok: false, error: 'remotePort required (use frp_connect_egress for sticky alloc)' }

  const dir = ensureDir(clientConfigDir())
  const name = proxyName || `plugin-frp-${localIp.replace(/\./g, '-')}-${localPort}-${remotePort}`
  const toml = `# generated by plugin-frp — isolated client config
# does not modify other frpc installs
serverAddr = ${JSON.stringify(serverAddr)}
serverPort = ${Number(serverPort)}
auth.method = "token"
auth.token = ${JSON.stringify(token)}
loginFailExit = false
transport.tcpMux = true
transport.tls.enable = false
transport.heartbeatInterval = 10
transport.heartbeatTimeout = 30
transport.dialServerTimeout = 10
transport.poolCount = 1

[[proxies]]
name = ${JSON.stringify(name)}
type = "tcp"
localIP = ${JSON.stringify(localIp)}
localPort = ${Number(localPort)}
remotePort = ${Number(remotePort)}
`
  const tomlPath = path.join(dir, 'frpc.toml')
  fs.writeFileSync(tomlPath, toml, { mode: 0o600 })
  const meta = {
    SERVER_ADDR: serverAddr,
    SERVER_PORT: Number(serverPort),
    LOCAL_IP: localIp,
    LOCAL_PORT: Number(localPort),
    REMOTE_PORT: Number(remotePort),
    PROXY_NAME: name,
  }
  fs.writeFileSync(path.join(dir, 'frpc-local.env'), Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return {
    ok: true,
    tomlPath,
    publicTarget: `${serverAddr}:${remotePort}`,
    sshHint: `ssh -p ${remotePort} USER@${serverAddr}`,
    note: 'Proxy name prefixed with plugin-frp- to avoid colliding with other tunnels.',
  }
}

export function startClientBackground() {
  const dir = clientConfigDir()
  const toml = path.join(dir, 'frpc.toml')
  if (!fs.existsSync(toml)) return { ok: false, error: `missing ${toml}` }
  const bin = path.join(dir, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  if (!fs.existsSync(bin)) {
    const inst = installClient()
    if (!inst.ok) return inst
  }
  const logFile = path.join(dir, 'frpc.log')
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath '${bin}' -ArgumentList '-c','${toml}' -WindowStyle Hidden -RedirectStandardOutput '${logFile}' -RedirectStandardError '${logFile}'`,
    ], { encoding: 'utf8' })
    return { ok: r.status === 0, logFile, stderr: r.stderr }
  }
  const r = spawnSync('bash', ['-lc', `nohup '${bin}' -c '${toml}' >'${logFile}' 2>&1 & echo $!`], { encoding: 'utf8' })
  return { ok: r.status === 0, pid: (r.stdout || '').trim(), logFile }
}

/** List currently listening allowPorts proxies on the frps host (read-only). */
export async function listOnlineProxies() {
  const listen = run('bash', [
    '-lc',
    "ss -tlnp | awk '/frps/ {print}' | head -40",
  ])
  const ports = run('bash', [
    '-lc',
    "ss -tlnp | awk '/frps/ && $4 ~ /:60[0-9]{3}$/ { gsub(/.*:/,\"\",$4); print $4 }' | sort -n | uniq",
  ])
  const recent = run('bash', [
    '-lc',
    "journalctl -u frps -n 40 --no-pager 2>/dev/null | grep -E 'new proxy|client login|token in login' | tail -20 || true",
  ])
  const allowPortListeners = (ports.stdout || '').split(/\s+/).filter(Boolean).map(Number)
  const sync = await withOpsStore(
    (store) => store.syncOnlineFromPorts(allowPortListeners),
    { skipped: true, reason: 'plugin-ops-store not installed' },
  )
  const leases = await withOpsStore(
    (store) => store.listLeases({ status: 'active' }),
    [],
  )
  return {
    ok: true,
    allowPortListeners,
    listenLines: (listen.stdout || '').split('\n').filter(Boolean),
    recentLog: (recent.stdout || '').split('\n').filter(Boolean),
    leaseSync: sync,
    activeLeases: leases,
    dashboard: {
      urlPath: '/ops/frp/',
      bind: '127.0.0.1:7500',
      note: 'Dashboard is loopback-only; use nginx /ops/frp/ on the public domain.',
    },
  }
}

export function stopClientBackground() {
  const dir = clientConfigDir()
  if (process.platform === 'win32') {
    const r = run('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='frpc.exe'\" | Where-Object { $_.CommandLine -match 'plugin-frp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'",
    ])
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr }
  }
  if (fs.existsSync('/etc/systemd/system/plugin-frpc.service')) {
    run('systemctl', ['stop', 'plugin-frpc'])
  }
  const r = run('bash', [
    '-lc',
    `pkill -f '${dir.replace(/'/g, "'\\''")}/frpc' 2>/dev/null || true; echo stopped`,
  ])
  return { ok: true, stdout: r.stdout }
}

/** Install systemd unit so frpc comes back after reboot. */
export function enableClientAutostart() {
  const dir = clientConfigDir()
  const toml = path.join(dir, 'frpc.toml')
  const bin = path.join(dir, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  if (!fs.existsSync(toml)) return { ok: false, error: `missing ${toml}` }
  if (!fs.existsSync(bin)) {
    const inst = installClient()
    if (!inst.ok) return inst
  }
  if (process.platform === 'win32') {
    const task = 'plugin-frpc'
    const r = run('powershell', [
      '-NoProfile', '-Command',
      `$n='${task}'; Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue; ` +
      `$a=New-ScheduledTaskAction -Execute '${bin}' -Argument '-c "${toml}"'; ` +
      `$t=New-ScheduledTaskTrigger -AtStartup; ` +
      `$s=New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries; ` +
      `Register-ScheduledTask -TaskName $n -Action $a -Trigger $t -Settings $s -RunLevel Highest -Force | Out-Null; 'ok'`,
    ])
    return { ok: r.status === 0, mechanism: 'ScheduledTask', name: task, stdout: r.stdout, stderr: r.stderr }
  }
  const unit = `[Unit]
Description=plugin-frpc (isolated egress client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} -c ${toml}
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`
  fs.writeFileSync('/etc/systemd/system/plugin-frpc.service', unit)
  run('systemctl', ['daemon-reload'])
  const en = run('systemctl', ['enable', '--now', 'plugin-frpc'])
  return {
    ok: en.status === 0,
    mechanism: 'systemd',
    unit: 'plugin-frpc.service',
    stdout: en.stdout,
    stderr: en.stderr,
  }
}

/**
 * Sticky egress connect (typical: localPort=22).
 * Allocates/reuses remote port via plugin-ops-store SQLite, writes frpc.toml, starts + enables autostart.
 */
export async function connectEgress({
  localPort = 22,
  localIp = '127.0.0.1',
  clientId,
  remotePort,
  autostart = true,
} = {}) {
  const gate = requireServerAddr()
  if (!gate.ok) return gate
  const creds = gate.creds
  const id = clientId || creds.FRP_CLIENT_ID

  let leaseRemote = remotePort
  let leaseMeta = null
  const online = await listOnlineProxies().catch(() => ({ allowPortListeners: [] }))
  const alloc = await withOpsStore(
    (store) => store.allocLease({
      clientId: id,
      localPort: Number(localPort),
      localIp,
      serverAddr: creds.FRP_SERVER_ADDR,
      listeningPorts: online.allowPortListeners || [],
      reuse: true,
    }),
    null,
  )
  if (alloc?.ok) {
    leaseRemote = alloc.lease.remote_port
    leaseMeta = alloc
  } else if (!leaseRemote) {
    return {
      ok: false,
      error: 'plugin-ops-store required for sticky port alloc (or pass remotePort). Install github:tingaidehua/plugin-ops-store alongside plugin-frp.',
    }
  }

  const written = writeClientConfig({
    serverAddr: creds.FRP_SERVER_ADDR,
    serverPort: Number(creds.FRP_SERVER_PORT || 7000),
    localIp,
    localPort: Number(localPort),
    remotePort: Number(leaseRemote),
    proxyName: leaseMeta?.lease?.proxy_name,
  })
  if (!written.ok) return written

  stopClientBackground()
  const started = autostart ? enableClientAutostart() : startClientBackground()
  if (leaseMeta?.lease?.id) {
    await withOpsStore((store) => {
      store.markLeaseSuccess(leaseMeta.lease.id)
      store.notifyPush({
        level: 'info',
        title: `frp egress :${localPort} → :${leaseRemote}`,
        body: written.sshHint,
        source: 'plugin-frp',
      })
    }, null)
  }
  return {
    ok: !!started.ok,
    action: 'connected',
    clientId: id,
    localPort: Number(localPort),
    remotePort: Number(leaseRemote),
    sticky: !!alloc?.ok,
    alloc,
    written,
    autostart: started,
    disconnectHint: 'Call frp_disconnect when done (default stop keeps sticky port for reconnect).',
  }
}

/** Default disconnect: stop frpc, keep sticky lease unless forgetPort=true. */
export async function disconnectEgress({
  localPort = 22,
  clientId,
  forgetPort = false,
} = {}) {
  const creds = loadCredentials()
  const id = clientId || creds.FRP_CLIENT_ID
  const stopped = stopClientBackground()
  const released = await withOpsStore(
    (store) => store.releaseLease(id, Number(localPort), { forgetPort }),
    { skipped: true },
  )
  await withOpsStore((store) => store.notifyPush({
    level: 'info',
    title: `frp disconnect local :${localPort}`,
    body: forgetPort ? 'lease forgotten' : 'stopped; sticky port kept for reconnect',
    source: 'plugin-frp',
  }), null)
  return { ok: true, stopped, released, forgetPort }
}
