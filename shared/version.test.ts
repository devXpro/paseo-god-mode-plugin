import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "./version.ts";

const root = join(import.meta.dirname, "..");
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8");

test("every place that carries the version carries the one in package.json", () => {
  const { version } = JSON.parse(read("package.json"));
  assert.equal(VERSION, version, "shared/version.ts");
  assert.equal(/VERSION = "([^"]+)"/.exec(read("gpt-site", "core", "version.mjs"))?.[1], version, "gpt-site/core/version.mjs");
  assert.equal(JSON.parse(read("gpt-site", "package.json")).version, version, "gpt-site/package.json");
  const lock = JSON.parse(read("gpt-site", "package-lock.json"));
  assert.equal(lock.packages[""].version, version, "gpt-site/package-lock.json");
});
