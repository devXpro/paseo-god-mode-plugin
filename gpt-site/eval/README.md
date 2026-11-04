# Tool-selection eval

Measures what a real OpenAI model does with God Mode's instructions and tool descriptions: which
tool it calls first for a phrase, with which arguments, how many calls it makes, whether it acts on
agents only when told to, and whether what it says matches the result of the call.

The model runs in `codex exec` (the CLI inside the ChatGPT desktop app) with one MCP server, the
stub in this folder. The stub serves the real `core/mcp.mjs` of the version under test — its
instructions, tool list and argument checks — on top of fake Paseo operations over a fixed world
(`world.mjs`), so write tools only change memory. It reads no secrets and opens no sockets.

## Files

| File | What it is |
| --- | --- |
| `cases.mjs` | About 120 phrases in Russian and English: direct, indirect, elliptic with an earlier conversation, negative, a write-safety block (preparing, sending, unclear, discussion, outcome after a call, duplicates) and a regression block from real incidents (`--block regression`). Each has the ideal first call, acceptable ones, arguments, the number of writes, deliveries and calls. |
| `world.mjs` | The fake Paseo: projects, chats, turns, an approval, subagents, a backgrounded workflow. |
| `ops.mjs` | The fake operations, built on the version's own `text.mjs` helpers. |
| `stub.mjs` | The MCP server Codex starts over stdio, one per run. |
| `run.mjs` | Runs the cases. `baseline` = `core/` at a git tag (`--baseline-ref`, default `v0.5.0`), `current` = `core/` as it is. |
| `judge.mjs` | Grades the spoken replies the scoring cannot read itself (claims it was done, asks to confirm, gives a draft…). |
| `report.mjs` | Scores everything into `results/report.md`. |
| `quota.mjs` | Shows how much of the Codex usage windows is used, without a model call. |
| `system.md` | A ChatGPT-like voice system prompt that replaces Codex's coding prompt. |

## Run

```sh
node eval/quota.mjs                                                    # before and between runs
node eval/run.mjs --out after --variants current --filter '^(core|w|r)\.' --parallel 2
node eval/judge.mjs after
node eval/report.mjs before after                                      # → eval/results/report.md
```

One run of the whole set is about 117 short Codex sessions, ~14k input tokens each (most of it
cached), roughly 12% of a Plus 5-hour window with `gpt-6.1-sol` at low effort; run it with
`--parallel 1` or 2, since that model answers 429 to bursts.

## Long texts

`long/` checks what the main set cannot: whether a model reads a cut answer on by itself when the
question needs the rest (a reply's last points, every subagent's findings, every match, how an agent
reasoned, which tests failed, the error at the end of a log) and leaves it when it does not (a gist,
a count). Its stub serves the checkout's real operations (`core/paseo.mjs`) over a fake Paseo in
`long/world.mjs` whose long texts hide facts in their tails; a case passes when the reply holds them.

```sh
node eval/long/run.mjs --check          # --check: refuse numbers above a schema maximum, as ChatGPT does
```

Eight cases, about 0.5% of a Plus 5-hour window each with `gpt-6.1-sol` at low effort. The model is
not deterministic: run a case more than once before trusting a change. Measured on 2026-11-04: the
thinking case failed every run until the instructions said an agent's thinking is not hidden and
not the model's own reasoning (it declined to retell "hidden internal reasoning"), then passed five
runs of five; the other seven passed in every run.

## Isolation

Every run passes `--ignore-user-config`, `--disable apps`, `--disable plugins`, `--disable
shell_tool` and the rest (see `DISABLED` in `run.mjs`), so ChatGPT apps (the real God Mode plugin),
the user's own MCP servers and plugins, the shell and web search are all off. Codex's code mode
can only call the session's tools. The runner aborts the whole eval on any event that is not a
message, reasoning or a stub tool call; `probe.*` cases check that a shell and the web are out of
reach.

## Limits

- `codex exec` is a stand-in for ChatGPT voice: another client, the same family of models.
- Codex gives the model only `structuredContent` when a result has it; ChatGPT gives the text too.
  The eval measures choices and arguments, not how the result text sounds.
- An earlier conversation is rendered into the user message, not replayed as real turns.
- The judge is a model too; spot-check its grades when a number moves.
