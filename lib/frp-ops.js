import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  clientConfigDir,
  ensureDir,
  serverFrpsToml,
  vendorBinary,
} from './paths.js'
import { loadCredentials, requireServerAddr, saveCredentials } from './credentials.js'
import { withOpsStore } from './ops-store.js'

function run(cmd, args, opts = {}) {
  // Never shell-wrap argv on Windows — cmd.exe mangles PowerShell pipelines.
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...opts,
  })
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message) : '',
  }
}

const POWERSHELL = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell'

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

function downloadFrpcRelease(destPath) {
  const ver = process.env.FRP_VERSION || '0.71.0'
  const plat = process.platform === 'win32' ? 'windows' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const asset = `frp_${ver}_${plat}_${arch}.${plat === 'windows' ? 'zip' : 'tar.gz'}`
  const mirrors = [
    `https://mirror4.lzu.edu.cn/github-release/fatedier/frp/v${ver}/${asset}`,
    `https://ghproxy.net/https://github.com/fatedier/frp/releases/download/v${ver}/${asset}`,
    `https://github.com/fatedier/frp/releases/download/v${ver}/${asset}`,
  ]
  const tmp = path.join(os.tmpdir(), `plugin-frp-${asset}`)
  let lastErr = ''
  for (const url of mirrors) {
    const dl = run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '-fsSL', '-o', tmp, url,
    ])
    if (dl.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
      lastErr = dl.stderr || dl.error || `download failed ${url}`
      continue
    }
    const extractDir = path.join(os.tmpdir(), `plugin-frp-extract-${ver}`)
    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* */ }
    fs.mkdirSync(extractDir, { recursive: true })
    if (plat === 'windows') {
      run('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -Path '${tmp.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`])
    } else {
      run('tar', ['-xzf', tmp, '-C', extractDir])
    }
    const binName = plat === 'windows' ? 'frpc.exe' : 'frpc'
    const found = findFile(extractDir, binName)
    if (!found) {
      lastErr = `extracted but ${binName} missing`
      continue
    }
    fs.copyFileSync(found, destPath)
    if (plat !== 'windows') fs.chmodSync(destPath, 0o755)
    return { ok: true, source: url, version: ver }
  }
  return { ok: false, error: lastErr || 'all frpc mirrors failed' }
}

function findFile(root, name) {
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

export function installClient() {
  const dir = ensureDir(clientConfigDir())
  const dest = path.join(dir, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  const binSrc = vendorBinary('frpc')
  if (fs.existsSync(binSrc)) {
    fs.copyFileSync(binSrc, dest)
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
    return { ok: true, frpcPath: dest, configDir: dir, source: 'vendor' }
  }
  if (fs.existsSync(dest)) {
    return { ok: true, frpcPath: dest, configDir: dir, source: 'existing' }
  }
  const dl = downloadFrpcRelease(dest)
  if (!dl.ok) {
    return { ok: false, error: `missing vendor binary and download failed: ${dl.error}` }
  }
  return { ok: true, frpcPath: dest, configDir: dir, ...dl }
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
  const tomlPath = path.join(dir, 'frpc.toml')
  /** @type {Map<number, {name:string,localIp:string,localPort:number,remotePort:number}>} */
  const proxies = new Map()
  if (fs.existsSync(tomlPath)) {
    const prev = fs.readFileSync(tomlPath, 'utf8')
    const blocks = prev.split(/\[\[proxies\]\]/i).slice(1)
    for (const b of blocks) {
      const lp = Number((b.match(/localPort\s*=\s*(\d+)/i) || [])[1])
      const rp = Number((b.match(/remotePort\s*=\s*(\d+)/i) || [])[1])
      const lip = (b.match(/localIP\s*=\s*"([^"]+)"/i) || [])[1] || '127.0.0.1'
      const pn = (b.match(/name\s*=\s*"([^"]+)"/i) || [])[1]
      if (lp && rp) proxies.set(lp, { name: pn || `plugin-frp-${lp}-${rp}`, localIp: lip, localPort: lp, remotePort: rp })
    }
  }
  proxies.set(Number(localPort), {
    name,
    localIp,
    localPort: Number(localPort),
    remotePort: Number(remotePort),
  })
  const proxyToml = [...proxies.values()].map((p) => `[[proxies]]
name = ${JSON.stringify(p.name)}
type = "tcp"
localIP = ${JSON.stringify(p.localIp)}
localPort = ${Number(p.localPort)}
remotePort = ${Number(p.remotePort)}
`).join('\n')
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

${proxyToml}`
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
    proxies: [...proxies.values()],
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
  const errFile = path.join(dir, 'frpc.err.log')
  if (process.platform === 'win32') {
    // Separate stdout/stderr paths required by Start-Process.
    const r = spawnSync(POWERSHELL, [
      '-NoProfile', '-Command',
      `Start-Process -FilePath '${bin.replace(/'/g, "''")}' -ArgumentList @('-c','${toml.replace(/'/g, "''")}') -WindowStyle Hidden -RedirectStandardOutput '${logFile.replace(/'/g, "''")}' -RedirectStandardError '${errFile.replace(/'/g, "''")}'`,
    ], { encoding: 'utf8', shell: false, windowsHide: true })
    if (r.status === 0) return { ok: true, logFile, errFile, stdout: r.stdout }
    // Fallback: cmd start (no redirect)
    const r2 = spawnSync('cmd.exe', ['/c', 'start', '', '/B', bin, '-c', toml], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      cwd: dir,
    })
    return { ok: r2.status === 0, logFile, errFile, stderr: (r.stderr || '') + (r2.stderr || ''), stdout: r2.stdout }
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
    const marker = dir.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const r = run(POWERSHELL, [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" | Where-Object { $_.CommandLine -match 'plugin-frp|dsh-frp' -or $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'ok'`,
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
    const r = run(POWERSHELL, [
      '-NoProfile', '-Command',
      `$n='${task}'; Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue; ` +
      `$a=New-ScheduledTaskAction -Execute '${bin.replace(/'/g, "''")}' -Argument '-c "${toml.replace(/'/g, "''")}"'; ` +
      `$t=New-ScheduledTaskTrigger -AtStartup; ` +
      `$s=New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries; ` +
      `Register-ScheduledTask -TaskName $n -Action $a -Trigger $t -Settings $s -Force | Out-Null; 'ok'`,
    ])
    // Autostart may fail without elevation; caller still starts frpc in-process.
    return { ok: r.status === 0 && !/Access is denied|拒绝|denied/i.test(r.stderr || ''), mechanism: 'ScheduledTask', name: task, stdout: r.stdout, stderr: r.stderr }
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
  let auto = null
  if (autostart) {
    auto = enableClientAutostart()
  }
  // Always start frpc now; ScheduledTask may be blocked without elevation.
  const started = startClientBackground()
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
    started,
    autostart: auto,
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
