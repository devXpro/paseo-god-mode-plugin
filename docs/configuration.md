# Setup

God Mode has no settings to tune: one address and two connections. This page covers what each
button on its screen does, what it needs, and what God Mode keeps on the Mac.

## What you need

- A Mac running **Paseo 0.15.4** or newer with plugins on. The Mac has to be awake and online while
  Claude or ChatGPT uses God Mode.
- A domain in your own **Cloudflare** account. The free plan is enough; Cloudflare Registrar sells
  domains at cost. Keep that account to yourself and protect it with two-factor sign-in: whoever can
  edit its DNS or tunnels controls the address (see [security](security.md#the-tunnel-and-cloudflare)).
- **Claude** with custom connectors (add them on claude.ai or in the desktop app; the phone app picks
  them up, voice mode included), and/or **ChatGPT** Plus or Pro with custom MCP servers
  (chatgpt.com/plugins, on the web).
- For an install from GitHub, Node.js with npm: Paseo runs `npm ci` for God Mode's one runtime
  dependency. Homebrew is optional (see below).

## The address

**Address → Connect** on God Mode's screen:

1. God Mode looks for `cloudflared` (Homebrew's, or its own copy in `~/.paseo/god-mode/bin/`). If it
   is missing, it installs it with `brew install cloudflared`, or without Homebrew (and always on
   Windows) downloads Cloudflare's release build.
2. Cloudflare's sign-in page opens on the device where you pressed the button. Sign in, pick the
   domain, press **Authorize**. The link is good for about ten minutes; press Connect again for a new one.
3. God Mode creates a tunnel named `god-mode`, points `gm.<your domain>` at it, deletes the sign-in
   key and starts the tunnel. The screen then shows `gm.<your domain> · Working`.

The tunnel runs as long as Paseo runs, and God Mode restarts it when it stops. If you already made a
tunnel by hand, God Mode uses it as long as `~/.paseo/god-mode/tunnel.json` and the files in
`~/.paseo/god-mode/tunnel/` describe it.

## Connecting Claude

**Claude → Connect** copies the address (`https://gm.<your domain>/mcp`), shows a sign-in code and
opens Claude's connectors (claude.ai/customize/connectors). There:

1. **Add custom connector**, name it **God Mode** (Claude shows this name to the model), paste the
   address, **Add**. Leave the detected options: sign in now, register automatically.
2. **Connect**: God Mode's sign-in page opens. Enter the code from God Mode's screen.

The connector is then available in Claude on the web, on the desktop and in the phone app, voice mode
included. In Claude's connector settings you choose whether God Mode's tools ask before they run.

## Connecting ChatGPT

**ChatGPT → Connect** copies the address, shows a code and opens chatgpt.com/plugins. There:

1. **Add → Add custom MCP server**, name it **God Mode**, paste the address as the **Server URL**,
   choose **OAuth**, **Create**.
2. God Mode's sign-in page opens: enter the code.

ChatGPT's voice mode uses the plugins of your account, God Mode included.

## Codes and disconnecting

- A code is 8 digits, works once, for five minutes and five tries. If it ran out, press **New code** on
  God Mode's screen (or Connect again) and enter the new one.
- A connected assistant shows **Disconnect**: it signs that assistant out at once, and it has to be
  connected again with a new code. Removing the connector in Claude or ChatGPT does not sign it out on
  the Mac; use Disconnect for that.

## What God Mode keeps on the Mac

Everything is in `~/.paseo/god-mode/` (under `PASEO_HOME` if Paseo uses another home), readable only by
you:

| File | What it holds |
| --- | --- |
| `oauth.json` | Registered connections and their tokens, as SHA-256 hashes. |
| `secret` | The key confirmations of plugin actions and slash commands are signed with. |
| `calls.jsonl` | The call log: the latest 2000 tool calls, read by `get_logs`. |
| `tunnel.json` | The tunnel's address, hostname and id. |
| `tunnel/config.yml`, `tunnel/credentials.json` | The tunnel's configuration and credentials (`cloudflared` runs with them). |
| `tunnel/cloudflared.log` | What `cloudflared` printed. |
| `voice-button.json` | The voice button's settings. |
| `bin/cloudflared` (`cloudflared.exe` on Windows) | Only when God Mode downloaded `cloudflared` itself. |

God Mode reads Paseo's own `paseo.pid` and `local-credential` in `~/.paseo/` to reach the daemon, and
never copies them.

## The voice button

One switch, **ChatGPT voice in Paseo**: a button in Paseo that opens ChatGPT's own voice chat. See
[voice-button.md](voice-button.md).
