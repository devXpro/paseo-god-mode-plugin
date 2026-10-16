import assert from "node:assert/strict";
import { test } from "node:test";
import { run, runOrThrow } from "./process.ts";

test("a child that reads stdin sees it end instead of waiting forever", async () => {
  // `cat` echoes stdin until EOF; with stdin left open it would hang until the timeout.
  const result = await run("cat", [], { timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "");
});

test("failures carry a scrubbed tail and never reject run()", async () => {
  const result = await run("sh", ["-c", "echo 'Bearer abc123'; exit 3"]);
  assert.equal(result.ok, false);
  await assert.rejects(runOrThrow("sh", ["-c", "echo 'Bearer abc123' >&2; exit 3"]), (error: Error) => error.message.includes("Bearer [redacted]") && !error.message.includes("abc123"));
});
