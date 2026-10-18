# God Mode documentation

| Document | For | What is in it |
| --- | --- | --- |
| [architecture.md](architecture.md) | Everyone | The Site, the plugin, the relay; one tool call, one plugin action, one release. |
| [configuration.md](configuration.md) | Users | Every setting, where it lives, when it applies; what Paseo and ChatGPT need. |
| [tools.md](tools.md) | Users, developers | The tools ChatGPT gets, their arguments and conventions. |
| [plugin-tools.md](plugin-tools.md) | Plugin authors, developers | `plugin_read` and `plugin_action`: discovery, names, arguments, results, outcomes, confirmations. |
| [plugin-capabilities.md](plugin-capabilities.md) | Plugin authors | The `meta.describe` contract, `paseo.capabilities/1`: every field, `outcome`, `target`, `untrusted`. |
| [plugin-authoring.md](plugin-authoring.md) | Plugin authors | Implementing and testing `meta.describe` in a Paseo plugin; what not to describe. |
| [security.md](security.md) | Everyone | The trust model, writes and confirmations, what is and is not guaranteed, errors and outcomes. |
| [operations.md](operations.md) | Users | Update, apply settings, roll back; what a release job does; when ChatGPT shows old tools; troubleshooting. |
| [development.md](development.md) | Developers | Setup, checks, running against your Paseo, the eval, compatibility rules, releases. |

The design history and the reasoning behind the Site's choices: [gpt-site/DESIGN.md](../gpt-site/DESIGN.md).
Changes by version: [CHANGELOG.md](../CHANGELOG.md).
