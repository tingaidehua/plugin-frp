# plugin-frp

DeepSeek Harness plugin：公网 **frps** + 内网 **frpc** 出网（默认 22），配合 **plugin-ops-store** SQLite 做 sticky 端口。

## 安全

- **禁止**在源码写死 frps IP；用 `frp_configure` 问用户，写入 `~/.env` / `~/.config/plugin-frp/credentials.env`
- 已有 `/etc/frp/frps.toml` 时 `frp_install_server` 只收养，不改 token
- 客户端配置仅在 `~/.config/plugin-frp/`，proxy 名 `plugin-frp-*`

## 依赖

请并列安装：[plugin-ops-store](https://github.com/tingaidehua/plugin-ops-store)（共享 SQLite）。

```bash
dsh plugin --profile web add github:tingaidehua/plugin-ops-store
dsh plugin --profile web add github:tingaidehua/plugin-frp
```

## 内网智能体最小流程

```text
frp_configure({ FRP_SERVER_ADDR, FRP_TOKEN })
frp_connect_egress({ localPort: 22 })   # sticky remotePort + 开机自启
# …编程 / SSH…
frp_disconnect()                       # 默认保留端口记忆
```

原理见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 工具

| 工具 | 作用 |
|------|------|
| `frp_configure` | 保存用户提供的地址/token |
| `frp_connect_egress` | 出网（默认 22）+ sticky + 自启 |
| `frp_disconnect` | 默认断开（可 `forgetPort`） |
| `frp_list_online` | frps 侧检测 frpc 是否连上 |
| `frp_enable_autostart` | systemd / 计划任务 |
| `frp_status` / `frp_install_*` / … | 安装与状态 |

Tested against `@deepseek-ai/dsh@0.2.1-alpha.2`.
