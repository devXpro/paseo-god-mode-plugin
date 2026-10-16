// The plugin and the Site it publishes share one version. A test keeps this equal to package.json,
// which the host does not hand to plugin code. It continues paseo-remote's numbering (0.3.1 was
// its last release): ChatGPT refreshes a Site plugin's tools only when this version goes up.
export const VERSION = "0.4.1";
