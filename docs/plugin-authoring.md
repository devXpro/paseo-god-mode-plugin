# Writing a plugin God Mode can use

What a Paseo plugin needs so that ChatGPT can read it and act through it: one extra RPC,
`meta.describe`, answering [`paseo.capabilities/1`](plugin-capabilities.md). This page is the
how-to; the contract has the exact rules.

## Requirements

- A Paseo plugin with a server part (`index.server.ts` and `server.handle(...)` for its RPCs).
- Paseo supplies `zod` to plugin server bundles (Paseo 0.11.4 ships zod 4.4.3, which has
  `z.toJSONSchema`), so the descriptions can be rendered from the same zod contracts your handlers
  parse with.
- Describe only what is safe to offer a voice assistant that can mishear. See
  [What not to describe](#what-not-to-describe).

## Implementing meta.describe

Render each operation's input from your existing contracts, so the description cannot promise an
argument the handler refuses:

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
- Use `fixed` to split one RPC into plain operations (`dim`, `off`) instead of offering a mode.
- Use `output.fields` to keep plumbing and anything sensitive out of the answer; the same list is
  needed on actions whose RPC answers with a whole state.

## outcome, target and untrusted

- **outcome.** If an RPC reports failure in its answer instead of throwing (`{ ok: false, error }`,
  a non-empty `code`), declare those fields so a failure reads as "not done" rather than "done". Do
  not declare informational fields: a status whose `error` describes something else would turn
  every success into a refusal. An RPC that throws needs nothing.
- **target.** Give every action that asks first and acts on one thing (a message, a ticket, a chat) a
  `target`, so the user hears that thing's facts from your plugin instead of an id. You need a read
  that finds it by the action's arguments; if your plugin has none, add one, usually by id:

  ```ts
  export const getTicket = defineRpc({
    name: "desk.ticket",
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ id: z.string(), title: z.string(), owner: z.string(), error: z.string() }),
  });
  ```

  Describe it as a read with `outcome: { error: "error" }`, and point the action at it:
  `"target": { "read": "ticket", "args": { "id": "ticket" }, "show": ["title", "owner"] }`.
  Show stable fields that identify the thing; never a counter or a time that changes by itself, or
  the second read (right before running) always differs and the action is asked about again.
- **untrusted.** Mark every operation whose answer includes text written by someone else: chat
  messages, mail, tickets, web content.

## What not to describe

Leave out anything a misheard sentence must never trigger and anything a listener cannot use:

- credentials and keys (setting, reading or minting them), logins and sign-ins;
- settings writes, installs, updates, patches, restarts of Paseo or of the plugin;
- downloads and deletions of large data (models, archives);
- RPCs that answer with binary data (audio, images as base64);
- anything slower than a few seconds (God Mode gives a tool call 45 seconds in all, and Paseo stops
  waiting for a plugin RPC after 30).

## Testing

Unit tests that run without Paseo (the plugins that already do this use `node --test`):

- the description parses with your own zod schema of the shape and survives a JSON round trip;
- every operation's `method` is an RPC your plugin registers;
- for each operation, an example input passes its `input`, and merged under `fixed` passes the real
  contract's input;
- `fixed` keys are never offered in `input`;
- one default read at most; only `low` actions skip confirmation;
- `output.fields` never names a sensitive field;
- every `target` names a read of this plugin, maps all of its required arguments, and shows fields its
  answer has; every `outcome` field exists in the RPC's output.

Then pass the rendered description through God Mode's own parser, which is plain JavaScript, and make
sure nothing was dropped:

```sh
node --input-type=module -e '
  import { parseCapabilities } from "/path/to/paseo-god-mode-plugin/gpt-site/core/capabilities.mjs";
  import { describeLamp } from "/path/to/your-plugin/server/capabilities.server.ts";
  const parsed = parseCapabilities(describeLamp());
  console.log(parsed.invalid ?? parsed.capabilities.skipped);'
```

It must print `[]`.

## Checking it live

From a checkout of God Mode, in `gpt-site/` after `npm ci`, with your plugin reloaded in Paseo (the
probe takes the pairing link from `PASEO_PAIRING_URL` or asks `paseo pair` on the Mac):

```sh
node core/probe.mjs plugins                                    # the catalog, as ChatGPT gets it
node core/probe.mjs plugin-read lamp --json                    # the default read, structured
node core/probe.mjs plugin-act lamp dim --args '{"level":50}'  # runs for real
node core/probe.mjs plugin-act lamp off --json                 # needs_confirmation, with the token
node core/probe.mjs plugin-act lamp off --confirm <token>      # runs for real
```

The probe runs God Mode's code from that checkout, so it shows what a God Mode built from it will do.
Check confirmations without the `--confirm` step; run for real only what is safe to run.

## Releasing

- The description is read on every call, so a plugin release (and a reload in Paseo) is all it takes;
  God Mode needs no release for a new or changed plugin.
- A plugin that uses `outcome`, `target` or `untrusted` should go out after God Mode 0.10.0 is live
  (see [Compatibility](plugin-capabilities.md#compatibility)).
