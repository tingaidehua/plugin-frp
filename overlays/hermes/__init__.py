"""Hermes overlay for plugin-frp — delegates to Node DSH-native implementation."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

def _plugin_root() -> Path:
    here = Path(__file__).resolve().parent
    # Normal layout: <pkg>/overlays/hermes/__init__.py
    cand = here.parents[1]
    if (cand / "bin" / "invoke.mjs").exists():
        return cand
    env = os.environ.get("PLUGIN_FRP_ROOT")
    if env and (Path(env) / "bin" / "invoke.mjs").exists():
        return Path(env)
    # Hermes junction of overlay-only → sibling workspace package
    for p in (
        Path(r"C:\workspace\agent-plugins\plugin-frp"),
        Path.home() / "workspace" / "dsh-ops" / "plugin-frp",
        Path("/opt/agent-plugins/plugin-frp"),
        Path("/opt/plugin-ops/plugin-frp"),
    ):
        if (p / "bin" / "invoke.mjs").exists():
            return p
    return cand


PLUGIN_ROOT = _plugin_root()
INVOKE = PLUGIN_ROOT / "bin" / "invoke.mjs"


def _run(tool: str, params: dict | None = None) -> str:
    args = json.dumps(params or {}, ensure_ascii=False)
    node = os.environ.get("NODE_BIN", "node")
    try:
        r = subprocess.run(
            [node, str(INVOKE), tool, args],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(PLUGIN_ROOT),
        )
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})
    out = (r.stdout or "").strip() or (r.stderr or "").strip()
    if not out:
        return json.dumps({"ok": False, "error": f"empty output code={r.returncode}"})
    return out


def _handler(tool_name: str):
    def handle(params, **kwargs):
        del kwargs
        return _run(tool_name, dict(params or {}))

    return handle


TOOLS = [
    ("frp_configure", "Save FRP_SERVER_ADDR/TOKEN from user into ~/.env (never hardcode)."),
    ("frp_status", "Show frps/frpc status and whether credentials are configured."),
    ("frp_connect_egress", "Map local port (default 22) with sticky remote port + autostart."),
    ("frp_disconnect", "Stop frpc; keep sticky port unless forgetPort=true."),
    ("frp_list_online", "Detect frpc connections on frps + sync SQLite leases."),
    ("frp_enable_autostart", "Enable systemd/Scheduled Task for frpc reboot recovery."),
    ("frp_install_server", "Install/adopt frps (never overwrite token unless force)."),
    ("frp_install_client", "Install isolated frpc into ~/.config/plugin-frp."),
    ("frp_write_client_config", "Write frpc.toml (prefer frp_connect_egress)."),
    ("frp_start_client", "Start frpc background process."),
    ("frp_stop_client", "Stop dsh/plugin-frpc only."),
]


def register(ctx):
    for name, description in TOOLS:
        schema = {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": {}, "additionalProperties": True},
        }
        ctx.register_tool(
            name=name,
            toolset="plugin-frp",
            schema=schema,
            handler=_handler(name),
        )
