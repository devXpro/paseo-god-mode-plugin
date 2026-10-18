# Configuration

God Mode is configured in Paseo's sidebar. The settings are kept on your Mac and written to your
Site as environment variables, which is where the Site reads them.

## Where settings live and when they apply

- **On the Mac.** Section **3 · Preferences** of the sidebar; **Save** writes them to
  `~/.paseo/god-mode/preferences.json` (under `$PASEO_HOME` when Paseo sets it).
- **On the Site.** **Apply settings** (section 4) writes them, together with the link to this Mac, to
  the Site's environment and redeploys it. An update or a first publish writes them too. A variable
  reaches the Site only with a deploy.
- Changing a variable in the Site's own settings in ChatGPT works as well, but once preferences are
  saved on the Mac, the next Apply settings or update writes them over it. (Connecting a Site that
  has no saved preferences yet takes its current variables as the preferences.)

## Settings

| Sidebar | Site variable | Values | Default | Effect |
| --- | --- | --- | --- | --- |
| Language | `PASEO_LANGUAGE` | A language code, such as `en` or `de` | empty: the user's language | The language ChatGPT speaks; model-facing text stays English. |
| Model for new chats | `PASEO_NEW_CHAT_MODEL` | A model id Paseo knows | empty: Paseo's default | The model `start_chat` uses unless the user names one. |
| Thinking for new chats | `PASEO_NEW_CHAT_THINKING` | A thinking level the model offers | empty: Paseo's default | The thinking level `start_chat` uses unless the user names one. |
| Mode for new chats | `PASEO_NEW_CHAT_MODE` | `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan` | empty: Paseo's default | The mode `start_chat` uses; `bypassPermissions` skips every prompt in those chats. |
| Wait for an answer (seconds) | `PASEO_WAIT_SECONDS` | 0 to 25 | 15 | How long `start_chat` and `send_message` wait for a reply before answering "still working". |
| Confirm risky actions | `PASEO_CONFIRM_RISKY` | `on`, `off` | on | ChatGPT reads back approvals, stops, archiving and updates and waits for a yes. See [security.md](security.md#writes). |
| Keep a call log | `PASEO_LOG` | `on`, `off` | on | A row per tool call in the Site's D1 database, read with `get_logs`. |
| (written by the plugin) | `PASEO_PAIRING_URL` | The link from `paseo pair` | none: required | The key to your Paseo; stored as a Site secret. Without it every tool but `get_logs` refuses. |

For the on/off settings, `off`, `false`, `0` and `no` (any case) mean off; anything else means on, and
an empty value means the default.

Plugin actions have no setting of their own: what may run, and what asks first, is declared by each
plugin ([contract](plugin-capabilities.md)).

## Paseo

- Paseo 0.11 or newer on the Mac.
- **The relay must be on** (Paseo's settings): the Site reaches the Mac only through it. Section
  **1 · This Mac** checks it, along with Node.js (22.13 or newer), Git and the Codex CLI, which the
  plugin uses to build, publish and check the Site.
- The Mac awake and online while you use God Mode. When it is not, the tools say Paseo is offline and
  change nothing.

## ChatGPT

- ChatGPT Plus or Pro: the plans that include ChatGPT Sites.
- Section **5 · Use it in ChatGPT** links to the Site's plugin. If ChatGPT does not show it, install or
  connect it in ChatGPT under Plugins, *Created by you*.
- After an update that adds or changes tools, ChatGPT can take minutes to show them, and a chat keeps
  the tools it started with: open a new chat. See [operations.md](operations.md#when-chatgpt-still-shows-the-old-tools).
