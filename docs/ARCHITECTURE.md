# plugin-frp 原理：内网智能体万能出网口

## 目标

把公网 DSH + frps 打成**内网智能体的端口出口**（至少 SSH/22），配合运维插件箱。

```text
内网智能体 (plugin-frp client)
    --frpc-->  frps(公网)  --sticky remotePort-->  公网 ssh -p N user@FRP_SERVER_ADDR
                     ^
                     +-- plugin-ops-store SQLite 记忆 N，断线重连仍用 N
```

## 密钥与地址（禁止写进源码）

| 项 | 来源 |
|----|------|
| `FRP_SERVER_ADDR` | **问用户**，`frp_configure` 写入 `~/.env` + `~/.config/plugin-frp/credentials.env` |
| `FRP_TOKEN` | 同上 |
| `FRP_PUBLIC_BASE` | 可选，运维 HTTPS 根 |
| sticky `remotePort` | **SQLite**（`plugin-ops-store`），不是源码常量 |

## 共享库：plugin-ops-store

- 路径：`/var/lib/plugin-ops/ops.sqlite`（或 `PLUGIN_OPS_DB`）
- 表：`frp_leases` / `frp_events` / `notifications` / `kv` / `ops_audit`
- **不存** token；只存租约与运维状态
- 插件并列安装：`/opt/agent-plugins/plugin-ops-store` + `/opt/agent-plugins/plugin-frp`

## 推荐会话流（给另一个内网智能体）

1. 人类提供 frps 地址与 token → `frp_configure`
2. `frp_connect_egress`（`localPort=22`）→ 分配/复用 sticky 端口 → 写 toml → systemd/任务计划自启
3. 公网侧 `frp_list_online` 检测是否有 frpc 连上（并回写 lease online）
4. 用完 → `frp_disconnect`（默认保留端口记忆；`forgetPort=true` 才丢掉）

## 自启

- Linux：`plugin-frpc.service` `Restart=always`
- Windows：Scheduled Task `plugin-frpc` AtStartup

## 与「demo」无关

出网与运维路径用 `/ops/`、`/app/`、`/site/`；不要用 demo 命名降低定位。
