# Development

How to work on God Mode: setup, checks, local runs against your Paseo, compatibility rules and
releases. The parts and how they fit: [architecture.md](architecture.md).

## Setup

```sh
npm ci && npm --prefix gpt-site ci
paseo plugin add "$PWD"   # run the plugin from this checkout (the CLI is inside Paseo.app)
```

Node.js 22.13 or newer. After changing the plugin's code, reload it in Paseo; the Site's code
reaches ChatGPT only through a release.

## Checks

```sh
npm run check
```

It runs, in order:

1. the plugin's typecheck (`tsc --noEmit`);
2. the plugin's tests, `node --test "server/**/*.test.ts" "shared/**/*.test.ts"`;
3. the Site's check in `gpt-site/`: its hosting file, `node --test core/*.test.mjs` and its typecheck.

Every test runs without network or Paseo. The Site's operations are tested against fake daemon
clients (`core/images.test.mjs`, `core/capabilities.test.mjs`, `core/slash-flow.test.mjs`, which plays
Paseo's Claude and Codex providers as they behaved on live chats) and the tool layer against fake
operations (`core/mcp.test.mjs`); the slash command adapters on their own in `core/slash.test.mjs`. CI runs `npm run check` and `npm run build` on every push to `main`
and on pull requests.

## Running the Site's code against your Paseo

`gpt-site/core/probe.mjs` runs the same operations the Site runs, from this checkout, through the
relay, without a deploy. It takes the pairing link from `PASEO_PAIRING_URL`, or asks `paseo pair` on
the Mac running Paseo; it never prints it.

```sh
cd gpt-site
node core/probe.mjs overview [--hours 12]
node core/probe.mjs chats [--project P] [--status running|waiting|new|all] [--query Q] [--archived]
node core/probe.mjs read <chat> [--view text|commands] [--turn 1] [--turns 3] [--max N]
node core/probe.mjs activity [chat] [--max N]
node core/probe.mjs images [chat] [--turn N] [--image N] [--count N] [--save DIR]
node core/probe.mjs search <query…> [--project P] [--chat C] [--archived] [--scan 20] [--limit 10]
node core/probe.mjs plugins
node core/probe.mjs plugin-read <plugin> [operation] [--args JSON]
node core/probe.mjs plugin-act <plugin> <operation> [--args JSON] [--confirm TOKEN]
node core/probe.mjs commands <chat> [--query Q] [--limit 60]
node core/probe.mjs command <chat> <name> [args…] [--if-busy interrupt] [--confirm TOKEN] [--wait 15]
```

The write commands (`start`, `send`, `approve`, `stop`, `plugin-act`, `command`) act on your real
agents and plugins. `--json` prints the structured data instead of the text.

## The tool-selection eval

`gpt-site/eval/` measures what a real OpenAI model does with the instructions and tool descriptions,
through the Codex CLI against a stub server over a fake Paseo: see
[gpt-site/eval/README.md](../gpt-site/eval/README.md). Runs use your Codex usage allowance.

## Compatibility rules

- **One version** (`MAJOR.MINOR.PATCH`) covers the plugin and the Site it publishes.
- **Within a major version, tools are only added**, never removed or renamed, so a rollback never
  strands ChatGPT on tools that are gone. Output fields are added, not removed; a tool's
  `outputSchema` must not use a nullable object type (a test checks it), since ChatGPT may refuse such
  a tool list.
- **The plugin contract is additive**: new keys in [paseo.capabilities/1](plugin-capabilities.md) are
  optional, and God Mode ignores keys it does not know.
- **`@getpaseo/*` is pinned.** The relay path uses an internal entry point of `@getpaseo/client`;
  re-run the probe before bumping it.
- A change to anything the model reads (instructions, tool descriptions) changes the Site's
  `serverInfo.version` (the version plus a fingerprint of that text): ChatGPT kept old descriptions
  after a deploy that changed only the text and not the version. When ChatGPT actually re-reads the
  tools is its own business; see [operations.md](operations.md#when-chatgpt-still-shows-the-old-tools).

## Releasing

1. Add the version's section to [CHANGELOG.md](../CHANGELOG.md) (from `## [Unreleased]`).
2. `npm version X.Y.Z && git push --follow-tags`. `preversion` runs the checks; the version script
   writes the version into `shared/version.ts`, `gpt-site/core/version.mjs` and `gpt-site/package.json`
   (and its lock file), and npm commits "Release vX.Y.Z" and tags it.
3. The tag's workflow checks that the tag is the version in `package.json`, runs the checks and the
   build again, and publishes the GitHub release with the CHANGELOG section as its notes.
4. Publish the Site: update the plugin in Paseo to that version, then **Update** in the sidebar (or
   ask ChatGPT to update God Mode). See [operations.md](operations.md).
