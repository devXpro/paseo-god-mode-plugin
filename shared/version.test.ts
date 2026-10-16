import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "./version.ts";

const root = join(import.meta.dirname, "..");

test("the plugin and the Site it ships carry the version in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
  const site = readFileSync(join(root, "gpt-site", "core", "version.mjs"), "utf8");
  assert.equal(/VERSION = "([^"]+)"/.exec(site)?.[1], pkg.version, "gpt-site/core/version.mjs");
});
