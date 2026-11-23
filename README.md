# local-t3-bridge

A native **DSH Go** plugin that turns your Android phone into a first-class, peer-to-peer **T3 Code** environment — **no root, no Termux, no VPN required**.

It runs the official `t3` (`linux-arm64`) binary directly inside DSH Go's built-in Ubuntu container, bridges `dsh --profile acp` with full **ACP native session history replay (`session/load`)**, shares DSH Go's Android Accessibility phone-control bridge, and exposes DSH Go's chat sessions to remote PC agents over **T3 Linked Environments**.

---

## Architecture

```text
                T3 Connect (QUIC HTTPS Tunnel) / Linked Environments
        ┌──────────────────────────────┴──────────────────────────────┐
        ▼                              ▼                              ▼
  Windows T3 Code               Linux T3 Code              Android (DSH Go App)
  (Android dev / IDE)      (Server / WorkBuddy / etc.)   ├─ t3 serve (arm64, loopback)
                                                         ├─ acp-replay-proxy.mjs
                                                         │   ├─ initialize (+loadSession)
                                                         │   ├─ session/list (+titles/time)
                                                         │   └─ session/load (zstd replay -> resume)
                                                         └─ dsh --profile acp
                                                             ├─ DSH Go models & auth
                                                             ├─ phone MCP (Accessibility)
                                                             └─ sessions-mcp.mjs
```

### Why run inside DSH Go instead of Termux?

1. **Zero duplicate Linux containers**: DSH Go already ships Ubuntu 24.04 ARM64 + Node.js 24.
2. **Shared sandbox & `tawcroot` links**: DSH Go stores sessions as `session.v4.jsonl.zstd` using `tawcroot` hard-link emulation inside its private app storage. Running inside DSH Go gives `t3` direct read/write access with matching app UID — no root needed.
3. **Reuse Accessibility phone control**: `dsh --profile acp` loads `/opt/dsh-app/phone/phone.patch.yml`, letting PC T3 agents operate your phone UI whenever DSH Go is running.

---

## Features

- **Native DSH Go Control Panel** (accessible from the `+` composer tools menu, session plugins tab, and Features page):
  - One-tap **Install & Configure** (downloads official `t3-*-linux-arm64.tar.gz`, verifies SHA256, syncs models from DSH Go's `web` profile, writes T3 `settings.json`).
  - One-tap **Start / Stop / Refresh** for `t3 serve`.
  - Guided **T3 Connect** device authorization (auto-installs `cloudflared`, opens browser approval link).
  - One-tap **Pairing Code** minting & clipboard copy of `t3 environment link ...`.
- **Full Native T3 Session Import (ACP Replay Proxy)**:
  - `lib/acp-replay-proxy.mjs` intercepts `dsh --profile acp` to advertise `loadSession: true`, enrich `session/list` with real titles & timestamps from `session.v4.jsonl.zstd`, replay historical user/assistant turns via standard ACP `session/update` notifications on `session/load`, and translate to `session/resume` so model memory stays intact.
- **Cross-Device Session Handoff MCP (`dsh-sessions`)**:
  - `lib/sessions-mcp.mjs` exposes `list_dsh_sessions`, `read_dsh_session`, and `resume_dsh_session` so a PC T3 Code agent can take over half-finished mobile DSH Go tasks in a single prompt.

---

## Installation (inside DSH Go Shell)

```sh
PLUGIN_DIR="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-t3-bridge"
git clone https://github.com/lincriy/local-t3-bridge "$PLUGIN_DIR"

# (Optional) Validate with DSH Go's built-in plugin checker
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$PLUGIN_DIR" --load

# Install into DSH Go's web profile (--offline avoids re-fetching unrelated packages)
dsh plugin --profile web add --offline "$PLUGIN_DIR"
```

After installation, open **T3 跨端互联 (T3 Bridge)** from the `+` tool menu or **全部功能 (Features)** in DSH Go:

1. Tap **安装并配置 (Install & Configure)**.
2. Tap **T3 账号授权 (T3 Connect Auth)** → **打开授权页 (Open Auth Page)** and approve in browser.
3. Tap **启动服务 (Start Server)** and wait ~10 seconds for the QUIC tunnel to come online.
4. On your Windows/Linux T3 Code, enable **Settings → Labs → Linked environments**.
5. Back in DSH Go's panel, tap **生成配对码 (Mint Pairing Code)** → **复制互联命令 (Copy Link Command)** and run it on your PC.

### Shell Helper (Optional)

Installation also creates `~/.local/bin/t3-phone`:

```sh
t3-phone start    # Start t3 serve in background
t3-phone stop     # Stop gracefully
t3-phone restart  # Restart cleanly
t3-phone status   # Show PID and T3 Connect status
```

---

## Security Notes

- `t3 serve` binds strictly to `127.0.0.1:3773` (no unencrypted LAN port exposed); remote traffic travels over T3 Connect's authenticated QUIC HTTPS tunnel.
- Pairing codes are short-lived (15 minutes) and kept in memory only — never written to plugin manifests or source files.
- No system partitions or root privileges are used.

## Uninstall

```sh
t3-phone stop 2>/dev/null || true
dsh plugin --profile web remove local-t3-bridge
rm -rf "${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-t3-bridge"
```

## License

[MIT](./LICENSE)
