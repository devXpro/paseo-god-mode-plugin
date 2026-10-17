# Plugin capabilities: `paseo.capabilities/1`

How a Paseo plugin makes itself usable from ChatGPT through God Mode (0.8.0 and later): it answers
one RPC, `meta.describe`, with the shape below. God Mode knows no plugin by name, so a plugin that
implements this contract needs no God Mode release.

## Why a plugin describes itself

Paseo tells a remote client which plugins are installed and lets it call any plugin RPC by name
(`invokePluginRpc`). It does not say which methods exist, what they take, or which ones only read
and which ones change something. So a plugin opts in by answering `meta.describe`; one that does
not is listed as offering nothing, and God Mode calls nothing else of it. The description is not a
permission system, since a paired client can call any plugin RPC anyway. It decides what ChatGPT
is offered, when the user is asked first, and what ChatGPT hears back.

## The RPC

- Name `meta.describe`, input `{}`, registered with `server.handle` like any other RPC. It returns
  the description as plain JSON.
- God Mode calls it on every `plugin_read` and `plugin_action` call and caches nothing, so keep it
  cheap and free of side effects. It has 4 s to answer.
- `meta.*` is reserved for describing the plugin: an operation whose method starts with `meta.` is
  dropped.

## The description

```json
{
  "schema": "paseo.capabilities/1",
  "title": "Desk lamp",
  "summary": "The lamp on the desk: on or off, and how bright.",
  "aliases": ["light", "лампа"],
  "operations": [
    { "id": "state", "kind": "read", "method": "lamp.get", "title": "Lamp state", "default": true,
      "input": { "type": "object", "properties": {} }, "output": { "fields": ["on", "level"] } },
    { "id": "dim", "kind": "action", "method": "lamp.set", "title": "Dim the lamp",
      "input": { "type": "object", "required": ["level"], "properties": { "level": {
        "anyOf": [{ "type": "number", "const": 10 }, { "type": "number", "const": 50 }, { "type": "number", "const": 100 }],
        "description": "Brightness in percent" } } },
      "fixed": { "mode": "level" }, "risk": "low", "confirm": "none", "output": { "fields": ["on", "level"] } },
    { "id": "off", "kind": "action", "method": "lamp.set", "title": "Turn the lamp off",
      "input": { "type": "object", "properties": {} }, "fixed": { "mode": "off" },
      "risk": "disruptive", "confirm": "always", "confirmText": "Turn the lamp off: the room goes dark." }
  ]
}
```

A text over its limit is cut. An `id` or `method` over its limit is refused, so it never turns
into another name.

| Top level | Rules |
| --- | --- |
| `schema` | Exactly `"paseo.capabilities/1"`. |
| `title` | Required. The plugin's name to ChatGPT; at most 80 characters. |
| `summary` | Optional. One line for the catalog; at most 300. |
| `aliases` | Optional. Other names people say, in any language: up to 20, each cut at 60. |
| `operations` | Required array. At most 40 usable operations are kept; any beyond are listed as dropped. |

| Operation | Rules |
| --- | --- |
| `id` | Required, unique, `^[a-z][a-z0-9_]*$`, at most 64 characters. Of two equal ids, the first stays. |
| `kind` | `"read"` or `"action"`. |
| `method` | The real RPC of this plugin behind the operation: `^[a-z][a-z0-9._-]*$` (the SDK's rule), at most 120, never `meta.*`. Operations may share one. |
| `title` | Required; at most 80. What ChatGPT names the operation by. |
| `description` | Optional; at most 600. ChatGPT gets it with the operation in the catalog, and a read's answer carries it as `about`: say there how to read the answer. |
| `input` | JSON Schema of `"type": "object"` for what the caller supplies. Left out: no arguments. |
| `fixed` | Optional object God Mode merges into every call. None of its keys may be in `input.properties`. |
| `default` | Reads only. `true` marks the plugin's main read; when several say so, the first wins. |
| `output.fields` | Reads and actions. The top-level fields of the answer worth reading out; left out or empty, the whole answer. |
| `risk` | Actions only: `low`, `outward`, `disruptive` or `destructive`. Missing or unknown counts as `destructive`. |
| `confirm` | Actions only: `none` or `always`. Only a `low` action may skip asking; any other risk asks first, whatever this says. |
| `confirmText` | Actions only; at most 600. What the user hears before an action that asks first. |

Pick the risk by what a run by mistake costs: `low` stays on the machine and one more call undoes
it; `outward` reaches people or services; `disruptive` interrupts work or cuts the machine off;
`destructive` loses something for good. God Mode acts on one difference only, `low` or not; ChatGPT
sees the level with every action and in `needs_confirmation`.

A broken operation is dropped on its own and the rest stay usable: a bad or repeated id, an unknown
kind, a method that is not an RPC name or is `meta.*`, no title, an `input` that is not an object
schema, a `fixed` that is not an object or names an offered argument. The plugin is unavailable
when the answer is not `paseo.capabilities/1`, has no title or no `operations` array, or keeps no
usable operation; the catalog says why.

## How God Mode uses it

- **Discovery.** Each call lists the installed plugins and asks every running one for
  `meta.describe` at once. One that is not running, has no `meta.describe`, throws, takes longer
  than 4 s or answers something invalid is listed with the reason; the others still work. A plugin
  named by its exact id is the only one asked. Reload your plugin and the next call sees the change.
  `plugin_read` without a plugin returns all of it as the catalog, shown in
  [Checking it](#checking-it).
- **Names.** A plugin is found by its id, title or an alias, ignoring case; otherwise by the words
  the user said, against its id, manifest name, title and aliases ("the desk light" finds the lamp;
  words match on a shared start, so inflected forms work). An operation is found by its id, spaces
  read as `_`, or by the words of its id and title. When the match is not clear, ChatGPT asks the
  user. An exact id of the wrong kind is refused, naming the right tool.
- **The default read.** `plugin_read` with a plugin and no operation runs the default read; with no
  default, it answers with what the plugin offers: its reads and its actions. Every read's answer
  also lists the plugin's actions with their arguments, so ChatGPT can act without another lookup.
- **Arguments** are checked before anything is called. `args` must be an object, and at every
  level a key the schema does not name is refused unless that object's `additionalProperties` is
  `true` or a schema (then the value is checked against it). Values are checked for `type`
  (`integer` included), `const`, `enum`, `anyOf` and `oneOf` (one alternative must fit), `minimum`,
  `maximum`, `minLength`, `maxLength`, `required`, nested `properties` and `items`. The rest (`$ref`, `allOf`,
  `pattern`, `format`, `exclusiveMinimum`, array lengths) is left to your handler's contract, which
  checks again and alone fills in defaults. `fixed` is merged in last: repeating a fixed value is
  harmless, a different one is refused. A refusal says what the operation takes, such as
  `level: 10 | 50 | 100 (required) – Brightness in percent` (a property's `description`, first 80
  characters, after the dash).
- **Answers.** With `output.fields`, only those top-level fields are kept. Then every key, at any
  depth, whose name contains `token`, `secret`, `password`, `passwd`, `credential`, `cookie`,
  `bearer`, `authorization`, `api key` or `private key` (any case, with or without a separator) has
  its value replaced by `"[redacted]"` when the value is text: `token: "…"` goes, while
  `tokenCount: 3` and `hasToken: true` stay. A list or a bare value is wrapped as `{ "value": … }`, so `result` is
  always an object. ChatGPT gets it as structured content, and as `key: value` lines (empty strings
  and nulls left out, nested values as JSON) cut at 1,500 characters for a read, 800 for an action.
- **Time.** A whole tool call has 45 s, the relay connection (up to 8 s) and the descriptions
  included, and Paseo 0.11.4 stops waiting for a plugin RPC after 30 s without stopping the handler.
  An error reaches ChatGPT as "Paseo request failed: …" with the first 200 characters of its
  message; after an action, also "Unknown whether it took effect: never say it did." Answer within
  seconds: start long work and return its state.

## Actions that ask first

An action asks first when its risk is above `low`, or when it says `confirm: "always"`.

1. The first call checks the arguments and runs nothing. It answers `outcome: "needs_confirmation"`,
   `delivered: false`, `confirm_text`, `confirmation` (a token) and `expires_at`, and tells ChatGPT
   to say `confirm_text` and, only after the user's yes, call again with the same plugin, operation
   and args plus the token.
2. `confirm_text` is your `confirmText` with each `{argument}` filled in from the call, such as
   `Send «{text}» to {to}.`; any argument the caller chose that the text does not name follows in
   brackets, so no value goes unsaid. Without a `confirmText` it is the two titles,
   `Desk lamp: Turn the lamp off.`, with the caller's arguments in brackets.
3. The second call runs the action if the token fits this exact call. Otherwise a fresh token comes
   back, after "That confirmation expired." or "That confirmation was for something else."
4. A run answers `outcome: "done"`, `delivered: true` and "It ran once; never repeat it for this
   request."

The token is `<expiry in base 36>.<signature>`: HMAC-SHA256 over the expiry and the canonical JSON
(sorted keys) of the plugin id, operation id, method and arguments with `fixed` merged in, keyed
from the Site's pairing link, its one secret. It lasts two minutes and fits only those exact
arguments. It is not spent on use: God Mode relies on `delivered: true` and the rule never to repeat
a done action.

What the token proves is that God Mode put exactly this call and text to ChatGPT a moment ago, not
that the user said yes: that part is ChatGPT following its rules. So describe nothing you would not
accept being run by a model that misheard. `plugin_action` also needs a signed-in ChatGPT user;
service access cannot call it.

## Implementing it

Paseo supplies `zod` to plugin server bundles (Paseo 0.11.4 ships zod 4.4.3), and zod 4 renders
JSON Schema with `z.toJSONSchema`. Render each operation's input from the same zod contracts your
handlers parse with, and the description cannot promise an argument the handler refuses.

```ts
import { defineRpc } from "@getpaseo/plugin";
import { type ZodType, z } from "zod";

// shared/lamp.shared.ts: the contracts the handlers already parse with.
export const level = z.union([z.literal(10), z.literal(50), z.literal(100)]).describe("Brightness in percent");
const state = z.object({ on: z.boolean(), level: z.number().int(), wiring: z.string() });
const setInput = z.discriminatedUnion("mode", [z.object({ mode: z.literal("off") }), z.object({ mode: z.literal("level"), level })]);
export const getLamp = defineRpc({ name: "lamp.get", input: z.object({}), output: state });
export const setLamp = defineRpc({ name: "lamp.set", input: setInput, output: state });

// server/capabilities.server.ts
export const describeRpc = defineRpc({ name: "meta.describe", input: z.object({}), output: z.record(z.string(), z.unknown()) });

// `input` is what the caller supplies; merged under `fixed`, it must pass `contract.input`.
const STATE = ["on", "level"]; // `wiring` is plumbing, not for a listener
export const OPERATIONS = [
  { id: "state", kind: "read", contract: getLamp, title: "Lamp state", input: z.object({}), default: true, fields: STATE },
  { id: "dim", kind: "action", contract: setLamp, title: "Dim the lamp", input: z.object({ level }), fixed: { mode: "level" }, risk: "low", fields: STATE },
  { id: "off", kind: "action", contract: setLamp, title: "Turn the lamp off", input: z.object({}), fixed: { mode: "off" }, risk: "disruptive", confirmText: "Turn the lamp off: the room goes dark." },
];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

// Rendered on the first call, not at load: a schema that will not render costs this RPC only.
let described: Record<string, unknown> | null = null;
export function describeLamp() {
  described ??= {
    schema: "paseo.capabilities/1", title: "Desk lamp", aliases: ["light", "лампа"],
    summary: "The lamp on the desk: on or off, and how bright.",
    operations: OPERATIONS.map(({ contract, input, fields, risk, ...op }) => ({
      ...op, method: contract.name, input: jsonSchema(input),
      ...(fields ? { output: { fields } } : {}),
      ...(risk ? { risk, confirm: risk === "low" ? "none" : "always" } : {}),
    })),
  };
  return described;
}
```

In `contribute()`, next to the other handlers: `server.handle(describeRpc, () => describeLamp());`

- Render with `io: "input"`, so a field with a default reads as optional, and drop `$schema`.
- Render lazily and keep the result. `contribute()` runs when Paseo loads the plugin, and a schema
  that throws there takes the whole plugin down; inside `meta.describe` it costs that one RPC.
- Keep arguments flat, each with a `.describe()`: booleans, strings, numbers, enums and unions of
  literals (rendered as `anyOf` of `const`s, shown as `10 | 50 | 100`). A plain `z.object` is right;
  a `z.looseObject` lets any extra argument through.
- Use `fixed` to split one RPC into plain operations (`dim`, `off`) instead of offering a mode, and
  keep secret-sounding names off the answer fields a listener should hear.
- Unit-test that every operation's example arguments pass its `input` and, merged under `fixed`,
  its real contract:

```ts
const EXAMPLES: Record<string, Record<string, unknown>> = { dim: { level: 50 } }; // the rest take none
test("what each operation advertises, merged under fixed, is what its handler accepts", () => {
  for (const op of OPERATIONS) {
    const args = EXAMPLES[op.id] ?? {};
    assert.doesNotThrow(() => op.input.parse(args), op.id);
    assert.doesNotThrow(() => op.contract.input.parse({ ...args, ...op.fixed }), `${op.id} → ${op.contract.name}`);
  }
});
```

## Checking it

From a checkout of God Mode, in `gpt-site/` after `npm ci`, with the pairing link in
`PASEO_PAIRING_URL` (on the Mac that runs Paseo, the probe asks `paseo pair` for it):

```sh
node core/probe.mjs plugins                                    # the catalog, as ChatGPT gets it
node core/probe.mjs plugin-read lamp --json                    # the default read, structured
node core/probe.mjs plugin-act lamp dim --args '{"level":50}'  # runs for real
node core/probe.mjs plugin-act lamp off --json                 # needs_confirmation, with the token
node core/probe.mjs plugin-act lamp off --confirm <token>      # runs for real
```

With the lamp and a plugin that has no `meta.describe`, `plugins` prints:

```text
Plugins ChatGPT can use:
- Desk lamp (lamp): The lamp on the desk: on or off, and how bright.
  Reads (plugin_read): state (main).
  Actions (plugin_action): dim (level: 10 | 50 | 100 (required) – Brightness in percent); off [asks first].
Installed, nothing for ChatGPT: notes (does not describe itself to ChatGPT).
```

An operation your description offers that God Mode cannot use gets one more line under its plugin,
`Dropped from its description: <id> (<reason>)`, and appears in the data under `skipped`.
