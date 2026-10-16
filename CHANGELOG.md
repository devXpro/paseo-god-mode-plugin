# Changelog

All notable changes to God Mode. One version covers the Paseo plugin and the ChatGPT Site it
publishes; it follows [Semantic Versioning](https://semver.org), and this file follows
[Keep a Changelog](https://keepachangelog.com). Each `## [X.Y.Z]` section becomes the notes of the
GitHub release vX.Y.Z.

## [Unreleased]

## [0.5.0] - 2026-10-16

First public release.

### Added

- A God Mode entry in Paseo's sidebar that walks through the setup: checks this Mac, signs in to
  ChatGPT with a device code, creates or connects a private ChatGPT Site, keeps its preferences and
  hands it the key to this Mac as a Site secret.
- A release engine on the Mac: tests and builds the Site, publishes it, checks the live plugin and
  puts the previous version back by itself when the check fails. When ChatGPT keeps showing the
  previous tool list, it deploys the release once more so ChatGPT fetches the new one.
- `update_status` and `update_site` in the Site, so ChatGPT reports and starts updates and rollbacks
  by voice or chat. `update_site` runs only for a signed-in ChatGPT user.
- One version for the plugin and the Site. The Site reports which source it was built from and
  whether a newer release is out on GitHub; a ledger on the Mac maps each Sites version to its
  God Mode version.

### Notes

- Numbering continues from paseo-remote, the Site this grew out of (last release 0.3.1): ChatGPT
  refreshes a Site plugin's tools only when this version moves on.
