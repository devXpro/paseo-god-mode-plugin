// Copies the version in package.json to every other place that carries it. `npm version X.Y.Z`
// runs this (the "version" script) before it commits and tags vX.Y.Z.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const write = (path, text) => writeFileSync(new URL(path, root), text);
const { version } = JSON.parse(read("package.json"));

const replaceConst = (path) => {
  const text = read(path);
  const next = text.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`);
  if (!next.includes(`"${version}"`)) throw new Error(`${path}: no VERSION constant to update`);
  write(path, next);
};
replaceConst("shared/version.ts");
replaceConst("gpt-site/core/version.mjs");

const site = JSON.parse(read("gpt-site/package.json"));
site.version = version;
write("gpt-site/package.json", `${JSON.stringify(site, null, 2)}\n`);

const lock = JSON.parse(read("gpt-site/package-lock.json"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
write("gpt-site/package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

console.log(`version ${version} synced`);
