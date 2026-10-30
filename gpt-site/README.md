# paseo-remote

Talk to your [Paseo](https://paseo.sh) agents from ChatGPT, by voice or by text: hear what
needs you, read what an agent wrote or ran, start a chat in a project, answer an agent,
approve or stop it.

It is a private [ChatGPT Site](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)
whose MCP server becomes a plugin in your ChatGPT account. The Site connects to your Paseo
daemon through the Paseo relay, end-to-end encrypted, exactly like the Paseo phone app. Nothing
is installed on the computer running Paseo, and no port is opened.

```
ChatGPT (voice or text)
  -> paseo-remote plugin = the Site's MCP server (Cloudflare Worker hosted by OpenAI)
  -> Paseo relay, E2EE with the key from your pairing link
  -> Paseo daemon on your computer -> your agents
```

## Requirements

- ChatGPT Plus or Pro: Sites is not available on Free or Go.
- The ChatGPT desktop app, to deploy the Site from this folder.
- Paseo with its relay on, and the computer awake while you use it.

## Set up

1. Clone this repository and open the folder in the ChatGPT desktop app (Codex).
2. Ask: *"Deploy this project with sites as a new private site."* ChatGPT builds it,
   publishes it to you only, and creates its plugin.
3. Run `paseo pair` on the computer running Paseo and copy the link. Open the Site's settings,
   **Environment variables → Add variable**, name it `PASEO_PAIRING_URL`, paste the link.
   Never paste it into a chat.
4. Add any of the settings below, then ask Codex to redeploy: variables apply on deploy.
5. Install the plugin when ChatGPT offers it. The first time it acts, choose **Always allow**.
6. Optional: create a ChatGPT project, put the instructions from
   [Project instructions](#project-instructions) in it, and start voice chats there.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PASEO_PAIRING_URL` | required | The link from `paseo pair`. A full key to your Paseo: keep it in this variable only. |
| `PASEO_LANGUAGE` | unset | The language ChatGPT speaks with you, e.g. `ru`, `en`, `de`. Unset: the language you use. |
| `PASEO_NEW_CHAT_MODEL` | Paseo's default | Model for chats started from ChatGPT, e.g. `claude-sonnet-5-5` or `gpt-6.1-sol`; it brings its runtime. |
| `PASEO_NEW_CHAT_THINKING` | the model's default | A level the model offers: `low`, `medium`, `high`, `xhigh`, `max`; some Claude models also `off` and `ultracode`, Codex `ultra`. Left out where the chat's model lacks it. |
| `PASEO_NEW_CHAT_MODE` | Paseo's default | `default`, `acceptEdits`, `auto`, `bypassPermissions` (skips every prompt) or `plan`; Claude chats only. |
| `PASEO_WAIT_SECONDS` | `15` | How long a call waits for the agent's reply before saying it is still working. Max 25. |
| `PASEO_CONFIRM_RISKY` | `on` | ChatGPT reads back approvals, stops and archiving and waits for your yes. `off` acts at once. |
| `PASEO_LOG` | `on` | Keep a log of every call in the Site's database, for `get_logs`. |

A spoken request can override the runtime, model, thinking and mode for one new chat.

## Tools

| Tool | What it does |
| --- | --- |
| `overview` | Chats waiting for you, running chats, new replies, projects. |
| `list_chats` | Finds chats by title, workspace, branch or project with Paseo's own search, archive included on request; or lists a project's chats, or chats in a state. |
| `read_chat` | `text`: what was said, final message first; `turns: N` reads the last N turns in one call. `commands`: the shell commands and tool calls with output. `thinking`: the agent's reasoning, when the model shared any. Every view says how full the chat's context window is. |
| `read_activity` | What an agent and its subagents are doing right now: state, current step, each subagent's task, status, running time and result. Without a chat: every chat at work. |
| `show_images` | The screenshots and pictures in a chat, shown in ChatGPT by a widget and handed to the model where ChatGPT allows it: the newest, a turn's, or the N-th of a turn (`[image N]` in `read_chat`). Without a chat: the newest image of the most recent chats. |
| `search_messages` | Where something was said: searches the message text of the most recent chats in parallel, or of one chat, and returns chat, turn and snippet. |
| `list_models` | The runtimes Paseo can start (Claude, Codex…) with their models, thinking levels and modes. |
| `start_chat` | A new chat in a project, or as another tab of a workspace that exists, with your task as the first message, on the runtime and model you name. |
| `set_chat_model` | Change the model and the thinking level (effort) of a chat that exists, in that chat. |
| `send_message` | A follow-up or an answer to an existing chat. |
| `answer_approval` | Allow or deny what a chat is waiting for. |
| `stop_chat` | Cancel what a chat is doing now. |
| `archive_chat` | Archive a chat, like Archive in Paseo: hidden from the list, history kept, a new message brings it back. A working chat is left alone (`busy`). |
| `update_status` | Which God Mode version is live, whether the Mac or GitHub has a newer one, how the last update went. |
| `update_site` | Update God Mode to the version installed on the Mac, or roll it back; runs on the Mac. |
| `get_logs` | This plugin's own call log. |

Every tool except `get_logs` returns readable text plus `structuredContent` that matches its
declared `outputSchema`: chats with `id`, `short_id`, `title`, `project`, `status`, `state`,
`updated_at` (ISO 8601, UTC), `updated_ago`, and `context` (used, max and remaining tokens, percent used) when Paseo knows it; turns with `turn` (1 = latest), `position`,
`started_at`, `user_text`, `agent_text`, and `images` when the turn has some (pictures read as
`[image N]` in the text, never as a path on the Mac). An ambiguous name returns
`needs_clarification` with the candidates instead. `show_images` also returns the image bytes in
`_meta`, which only its widget sees.

Chats and projects are named the way you say them; the tools match names and ask back when
unsure. A write acts on a name only when one chat has it whole, and never picks between chats that
share a title. Names are matched among active chats only; archived chats are searched when you ask,
and reached by their id or short id. Terminals, files, git and daemon control are deliberately not
exposed.

## Project instructions

ChatGPT voice in a project reads the project's instructions. Something like:

```
I talk to you by voice, often on the move. Answer in one or two sentences.
For anything about my agents, chats, projects or Paseo, use the paseo-remote plugin
with as few calls as possible. Send nothing to an agent unless I say to send it.
```

The same call rules are in the plugin's server instructions and in the tool descriptions;
the project instructions only repeat the essentials for voice chats.

## Update a deployed Site

Set any new variables in the Site's settings first, so one deploy picks everything up. Then open
this folder in the ChatGPT desktop app and ask:

```
This folder is the source of my existing private Site (its project_id is in .openai/hosting.json). Deploy this version to that same Site and keep it private. The Site uses a D1 database with the binding DB; apply the migrations in drizzle/. Do not rewrite anything under core/. After deploying, make sure the paseo-remote plugin's tool list is refreshed (get_site with include_mcp_connection, then suggest the plugin if needed), and verify through the plugin itself, not with curl: list the tools you see with their input and output schemas, and call overview.
```

## Troubleshooting

- *"Paseo is offline"*: the computer running Paseo is asleep, or its relay is down.
- Ask ChatGPT for paseo-remote's logs (`get_logs`); paste them to whoever is fixing it.
- If the pairing link leaks, rotate the daemon key and pair your devices again.

## Develop

```sh
npm ci
node --test core/*.test.mjs          # unit tests, no network
node core/probe.mjs overview         # the real operations against your Paseo, via the relay
node core/probe.mjs read "chat name" --turns 3 --json
node core/probe.mjs activity                     # every chat at work, with its subagents
node core/probe.mjs search "some phrase" --archived
node eval/run.mjs --variants current --filter '^(core|w)\.'   # the tool-selection eval, see eval/README.md
```

`core/` holds everything that matters and runs under Node; `app/mcp/route.ts` only wires it
to the Worker. The probe takes the pairing link from `PASEO_PAIRING_URL` or from `paseo pair`.
`@getpaseo/*` is pinned: the relay path uses an internal client entry point, so re-run the
probe before bumping it. See [DESIGN.md](DESIGN.md) for the reasoning and
[SITES-STARTER.md](SITES-STARTER.md) for the Sites starter this was generated from.

Do not commit your own `.openai/hosting.json` to a public fork: it carries your Site's id.
