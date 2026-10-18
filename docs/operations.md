# Operations

Keeping God Mode's Site up to date, what a release job does, and what to do when something looks
wrong.

## Update, apply settings, roll back

All three run on the Mac as a job of the God Mode plugin; section **4 · Publish and update** of the
sidebar starts them and shows the job's log while it runs.

| Action | From | What it does |
| --- | --- | --- |
| **Update** (or **Publish** the first time) | Sidebar, or ChatGPT: "update God Mode" (`update_status`, then `update_site`) | Publishes the Site source shipped with the God Mode plugin installed in Paseo. When a newer release is on GitHub, God Mode says so: update the plugin in Paseo first. |
| **Apply settings** | Sidebar | Writes the preferences and the link to this Mac to the Site, then redeploys the live version. |
| **Roll back** | Sidebar, or ChatGPT: "roll God Mode back" | Deploys the release before the newest one again. |

## What a release job does

1. **Reading the Site** — its versions and which one is live.
2. **Preparing the release** — stages the Site source into a private checkout of the Site's
   repository. A source that is already live ends the job here.
3. **Building and testing** — `npm ci`, the Site's checks and its build, on the Mac.
4. **Saving settings to the Site** — the preferences and the link to this Mac.
5. **Pushing the source** and **Publishing** — the new version, through the Codex CLI.
6. **Verifying** — until the new deployment is live.
7. **Checking the live plugin** — through the Codex app-server, the way ChatGPT sees the plugin: that
   ChatGPT shows every tool with its current description, and read-only calls (`list_chats`,
   `overview`, `read_chat`, `search_messages`, and `read_activity`, `show_images` and `plugin_read`
   where ChatGPT shows them) answer and match their output schemas.
8. **Asking ChatGPT to pick up the new tools** — only when ChatGPT still shows the old tool list: see
   below.

A failing call in step 7 rolls back to the version that was live before ("Production is unchanged:
version N is still live."). If the rollback fails too, the job is marked critical. A tool list that
has not caught up is a warning, never a rollback.

The plugin keeps a ledger of which Sites version is which God Mode version
(`~/.paseo/god-mode/ledger.json`): Sites numbers deployments on its own (v1, v2, …).

## When ChatGPT still shows the old tools

ChatGPT keeps its own snapshot of a plugin's tools, and a chat keeps the tools it started with. This
is observed behaviour, not a documented ChatGPT contract:

- After a plain redeploy, ChatGPT re-read the Site's description but not its tool list. After the
  Site's settings were saved and the Site redeployed, it re-read the tool list within seconds. So step
  8 saves the settings again before deploying the same version once more.
- Even after ChatGPT re-reads the list, the new tools have taken between about one and eight minutes
  to appear. The job waits a few minutes and may end with "ChatGPT still shows the previous tool
  list"; the release itself is live.

What to do: wait about ten minutes and open a new chat. If the tools are still old, use **Apply
settings** once, wait again, and open a new chat.

## Troubleshooting

| Symptom | Where to look |
| --- | --- |
| "Paseo is offline" | The Mac is asleep or offline, or Paseo's relay is off (sidebar section 1 checks it). |
| A tool fails or answers oddly | Ask ChatGPT for God Mode's logs (`get_logs`): recent calls with their arguments, timing and errors. |
| A plugin is missing from `plugin_read` | The catalog says why: not running, does not describe itself, or an unusable description; dropped operations are listed with their reasons. See [plugin-authoring.md](plugin-authoring.md#testing). |
| A release job failed | Its log in sidebar section 4; the plugin's own output with `paseo plugin logs god-mode`. |
| Which deployment answered | The Site's Worker log in ChatGPT Sites shows each MCP request with its method and the script version that served it. |
| ChatGPT calls a tool that no longer exists | It is using an older tool list: open a new chat. |
