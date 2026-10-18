# plugin_read and plugin_action

The two ChatGPT tools through which God Mode reads and drives Paseo plugins that describe
themselves ([the contract](plugin-capabilities.md)). Nothing here is specific to any plugin.

## plugin_read

Read-only (`readOnlyHint: true`).

| Argument | Meaning |
| --- | --- |
| `plugin` | The plugin: its id, its title, an alias, or the words the user said. Empty: the catalog of every installed plugin. |
| `operation` | A read of that plugin, by id or by its words. Empty: the plugin's main (`default`) read. |
| `args` | The read's arguments, an object. |

What it answers (`structuredContent`, every field optional):

| Field | When |
| --- | --- |
| `plugins` | Without `plugin`: every installed plugin with `id`, `title`, `summary`, `available`, `reason` (when not available), `reads` (`id`, `title`, `description`, `args`, `main`), `actions` (`id`, `title`, `description`, `args`, `risk`, `asks_first`) and `skipped` (operations dropped from its description, with the reason). Also returned for a plugin that has no main read. |
| `plugin`, `title`, `operation` | Which read ran. |
| `about` | The read's `description`: how to read `result`. |
| `result` | The plugin's answer, trimmed to its `output.fields`; always an object. |
| `refused`, `reason` | The read's `outcome` says the plugin could not give it. |
| `untrusted` | The read is marked untrusted. |
| `actions` | The plugin's actions with their arguments, so `plugin_action` needs no lookup first. |
| `needs_clarification` | The plugin or the operation was not clear; `candidates` to ask the user about. |

## plugin_action

A write (`destructiveHint: true`, `openWorldHint: true`). It needs a signed-in ChatGPT user: a call
through service access (a bypass bearer) is refused, as for `update_site`.

| Argument | Meaning |
| --- | --- |
| `plugin` | Required. As for `plugin_read`. |
| `operation` | Required. An action of that plugin, by id or by its words. |
| `args` | The action's arguments; the `fixed` ones may be left out. |
| `confirmation` | The token from `needs_confirmation`, only after the user said yes. |

| Field | Meaning |
| --- | --- |
| `outcome` | `done`, `needs_confirmation` or `refused`. |
| `delivered` | `true`: the action ran, never repeat it. `false`: nothing happened (yet). |
| `reason` | Why it was refused. |
| `risk` | The action's risk, with `needs_confirmation`. |
| `confirm_text`, `confirmation`, `expires_at` | What to tell the user, the token, and when it expires. |
| `target`, `target_changed` | The facts about the action's target, read from the plugin; `target_changed` when they differ from what the user confirmed. |
| `untrusted` | The action is marked untrusted. |
| `result` | The plugin's answer, trimmed to its `output.fields`. |
| `needs_clarification` | As for `plugin_read`. |

## Discovery

Every call lists the installed plugins (`plugin.list`) and asks each running one for `meta.describe`,
all at once, with 4 seconds each. A plugin that is not running, has no `meta.describe`, throws,
answers late or answers an unusable description is listed with the reason, and the others still
work. When `plugin` is exactly a plugin's id, only that plugin is asked. Nothing is cached: a plugin
reloaded a minute ago is described as it is now. Measured through the relay: the catalog in about
1 s, a read in about 1.1 s.

The catalog as text:

```text
Plugins ChatGPT can use:
- Desk lamp (lamp): The lamp on the desk: on or off, and how bright.
  Reads (plugin_read): state (main).
  Actions (plugin_action): dim (level: 10 | 50 | 100 (required) – Brightness in percent); off [asks first].
Installed, nothing for ChatGPT: notes (does not describe itself to ChatGPT).
```

A plugin with dropped operations gets one more line, `Dropped from its description: <id> (<reason>)`.

## Names

- A plugin is found by its id, title or an alias, ignoring case; otherwise by the words the user said,
  against its id, manifest name, title and aliases (words match on a shared start, so inflected forms
  work). Several candidates, or none, become `needs_clarification` with the plugins to choose from.
- A plugin that is installed but does not describe itself answers that it offers nothing to ChatGPT,
  with the reason.
- An operation is found by its id (spaces read as `_`) or by the words of its id and title. An exact
  id of the wrong kind is refused, naming the other tool.

## Arguments

Checked before anything is called; a refusal is a JSON-RPC error that says what the operation takes,
such as `level: 10 | 50 | 100 (required) – Brightness in percent`.

- `args` must be an object.
- At every level, a key the schema does not name is refused unless that object's
  `additionalProperties` is `true` or a schema.
- Checked: `type` (`integer` included), `const`, `enum`, `anyOf`/`oneOf` (one alternative must fit),
  `minimum`, `maximum`, `minLength`, `maxLength`, `required`, nested `properties`, `items`. Not checked
  here: `$ref`, `allOf`, `pattern`, `format`, exclusive bounds, array lengths. The plugin's own
  contract checks again.
- `fixed` arguments are merged in last: repeating a fixed value is harmless, a different one is
  refused.

## Results

- With `output.fields`, only those top-level fields are kept.
- A key whose name contains `token`, `secret`, `password`, `passwd`, `credential`, `cookie`, `bearer`,
  `authorization`, `api key` or `private key` (any case, any depth) has its value replaced by
  `"[redacted]"` when the value is text; counts and flags stay.
- A list or a bare value is wrapped as `{ "value": … }`, so `result` is always an object.
- The text is `key: value` lines (empty strings and nulls left out, nested values as JSON), cut at
  1,500 characters for a read and 800 for an action. A read's text starts with its title and
  description and ends with the plugin's actions.

## Outcomes

| What happened | Answer |
| --- | --- |
| The action ran | `outcome: "done"`, `delivered: true`, "It ran once; never repeat it for this request." |
| The answer's `outcome` fields say it was not done | `outcome: "refused"`, `delivered: false`, `reason`, "Nothing happened; tell the user why." A read: `refused: true`, `reason`. |
| The plugin threw, or the call timed out | An error: "Paseo request failed: …"; for an action also "Unknown whether it took effect: never say it did." |
| The Mac is asleep or offline | An error: "Paseo is offline: the computer running it is probably asleep or disconnected." For an action also "Nothing was sent." |

## Actions that ask first

An action asks first when its risk is above `low`, or when it says `confirm: "always"`.

1. **First call.** Arguments are checked. With a `target`, its read runs and its shown fields become
   the facts. Nothing else runs. The answer is `outcome: "needs_confirmation"`, `delivered: false`,
   `confirm_text`, `confirmation`, `expires_at` (and `target`), with the instruction to say
   `confirm_text` and call again only after the user's yes.
2. **What the user hears.** `confirm_text` is the plugin's `confirmText` with `{argument}` and
   `{target.field}` filled in; any argument or fact it does not name follows in brackets. Without a
   `confirmText`: `<plugin title>: <action title>.` plus the same brackets.
3. **Second call.** With a `target`, its read runs again first. The action runs only if the token
   fits this exact call and these facts. Otherwise a new confirmation comes back, after "That
   confirmation expired.", "That confirmation was for something else." or "The target changed since
   the user confirmed; tell them what it is now." (`target_changed: true`).
4. **Target unavailable.** If the target's read fails on either call, the answer is
   `outcome: "refused"` with `reason: "its target could not be read: …"`, and nothing runs.

Example, first call of an action with a target:

```json
{
  "plugin": "desk", "title": "Help desk", "operation": "close",
  "outcome": "needs_confirmation", "delivered": false, "risk": "destructive",
  "confirm_text": "Close «Printer jams» filed by Ann?",
  "target": { "title": "Printer jams", "owner": "Ann" },
  "confirmation": "mfz9k2c0.N2Vh…Kq0.Xp4c…a1w",
  "expires_at": "2026-10-18T09:02:00.000Z"
}
```

The same call after the yes, when the plugin refused:

```json
{ "plugin": "desk", "title": "Help desk", "operation": "close",
  "outcome": "refused", "delivered": false, "reason": "already closed",
  "result": { "ok": false, "error": "already closed" } }
```

The token is `<expiry in base 36>.<signature>`, plus `.<facts signature>` when the action has a
target: HMAC-SHA256 over the plugin, operation, method and canonical arguments (and, separately,
over the shown facts), keyed from the Site's pairing link, valid two minutes. It is not spent on use.
What it does and does not prove: [security.md](security.md#plugin-actions-and-their-confirmation).

## Timing

A tool call has 45 seconds in all, the relay connection (up to 8 seconds) and the descriptions
included. Paseo 0.11 stops waiting for a plugin RPC after 30 seconds without stopping the handler.
A confirmed action with a target makes two extra reads (one per call).
