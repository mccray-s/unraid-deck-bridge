# Unraid Deck Bridge

English | [简体中文](README.zh-CN.md)

An Unraid plugin that adds Docker, host, plugin, and array management for **Unraid Deck** through the official `/graphql` endpoint. It uses official authentication and resource permissions without replacing the official Docker API.

## Features

- Create, inspect, and edit supported standalone Docker containers, with configuration previews.
- Import URL, XML, or local User/Default templates; explicitly adopt containers or reinstall from a selected User template.
- Check image updates, update individual containers or batches, restart containers, and cancel eligible Docker tasks.
- Query Docker networks, runtime information, creation defaults, and host devices.
- Preview and execute shutdown, reboot, supported plugin removal, array start/stop, and parity-check controls.
- Query task results and recovery information, and subscribe to progress after reconnecting.

See the [API reference](docs/api.md). Host support is defined by the [compatibility contract](contracts/compatibility.json); a minimum OS version does not imply write support on every newer release.

## Requirements

- Linux x86_64 Unraid with a compatible official API and an existing x64 Node runtime. The installer does not install these dependencies.
- Installation and removal require administrator access and may briefly restart the official API.

## Installation

1. Open your Unraid Web UI and go to the **Plugins** tab.
2. Select the **Install Plugin** tab.
3. Paste the following URL into the text field:
   ```text
   https://raw.githubusercontent.com/mccray-s/unraid-deck-bridge/main/unraid-deck-bridge.plg
   ```
4. Click **Install** and wait for installation to finish.
5. Open **Unraid Deck**, select the server, and refresh **Settings → Unraid Deck Bridge**. Confirm that its status is **Available**. If the API restart interrupts the connection, reconnect first.

The installer downloads and verifies the matching release package automatically. Plugin registration alone does not confirm activation; resolve any installation or availability error before using management controls.

After registration, activation waits at least 10 seconds, then requires three stable API observations two seconds apart, with a five-minute startup deadline. An API restart is only requested when extension files or registration need repair, or the running API has not loaded the expected adapter. Startup, authentication, and connection uncertainty cause waiting or failure, not a forced restart. Core or Docker unavailability alone does not request an API restart.

Lifecycle diagnostics survive reboots in `/boot/config/plugins/unraid-deck-bridge/logs/lifecycle.log`, with one rotated `.1` file, each capped at 256 KiB. They record startup phases, expected and loaded adapter versions, reload/skip decisions, and final activation status without credentials. Plugin registration is not the same as activation reaching `READY`.

## Updates and release identity

Use the normal **Plugins → Installed Plugins → Check for Updates / Update** flow, including upgrades from Bridge `0.1.1`. Do not uninstall first or clear settings, task journals, or recovery records. After the update, reconnect if needed and confirm **Available** in Unraid Deck; native plugin registration alone does not establish readiness.

The native plugin, Bridge and Core report the same release identity, for example `2026.10.29a`. Releases use `YYYY.MM.DD` with an optional same-day `a`–`z` revision, ordered as the base date, then `a` through `z`, then the next day. Published releases, including `2026.10.29`, remain immutable; fixes receive a new release identity. Full native update history is maintained in [CHANGELOG.md](CHANGELOG.md).

## Removal

1. Open your Unraid Web UI and go to **Plugins → Installed Plugins**.
2. Find **Unraid Deck Bridge** (`unraid-deck-bridge`).
3. Click **Remove**, confirm, and wait for removal to finish.

Removal deletes Bridge's settings and task history, but does not delete existing Docker containers, images, volumes, or user templates. The official API may restart briefly during removal.

## License

Bridge source is **GPL-2.0-or-later**; see [LICENSE](LICENSE). Third-party components retain their own licenses; see [vendor attribution](vendor/README.md).
