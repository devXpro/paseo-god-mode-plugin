// The plugin and the Site it publishes share one version: the "version" in package.json, which
// `npm version` copies here and into gpt-site (scripts/sync-version.mjs); a test keeps them equal.
// It continues paseo-remote's numbering (0.3.1 was its last release) because ChatGPT refreshes a
// Site plugin's tools only when this version moves on.
export const VERSION = "0.8.2";

/** Where releases are published, as GitHub tags vX.Y.Z. */
export const REPOSITORY = "devXpro/paseo-god-mode-plugin";
