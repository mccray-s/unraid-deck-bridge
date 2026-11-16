# Deck Bridge for Unraid®

English | [简体中文](README.zh-CN.md)

An Unraid plugin that adds Docker, host, plugin, and array management for the **Deck iOS app** through the official `/graphql` endpoint. It uses the API's authentication and resource permissions.

Unraid® is a registered trademark of Lime Technology, Inc. This application is not affiliated with, endorsed, or sponsored by Lime Technology, Inc.

## Features

- Create, inspect, and edit supported standalone Docker containers, with configuration previews.
- Import URL, XML, or local User/Default templates; explicitly adopt containers or reinstall from a selected User template.
- Check image updates, update individual containers or batches, restart containers, and cancel eligible Docker tasks.
- Query Docker networks, runtime information, creation defaults, and host devices.
- Browse host files and directories in read-only mode when choosing Docker mount paths for a new container (Bridge `2026.11.16` or later).
- Check for updates to installed Unraid plugins, update supported plugins individually or in batches, and view per-plugin progress, results, and logs (Bridge `2026.11.16` or later).
- Preview and execute shutdown, reboot, supported plugin removal, array start/stop, and parity-check controls.
- Query task results and recovery information, and subscribe to progress after reconnecting.

See the [API reference](docs/api.md). Host support is defined by the [compatibility contract](contracts/compatibility.json); a minimum OS version does not imply write support on every newer release.

## Requirements

- Linux x86_64 Unraid OS 6.12.0 or newer, official API 4.25.3 or newer, and an existing x64 Node runtime. The installer does not install these dependencies.
- Valid prerelease versions, including RC and Beta, are accepted when above the minimum. A prerelease of the minimum version itself remains below that stable release. Build metadata does not affect version comparisons.
- Installation and removal require administrator access and may briefly restart the official API.
- Newer OS/API versions are not rejected or made read-only merely because they lack a source audit entry. Required runtime dependencies, official permissions, component consistency, and operation-specific interface/input checks still apply.

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

## Support

Report problems in [GitHub Issues](https://github.com/mccray-s/unraid-deck-bridge/issues). Include your Bridge, Unraid OS, and Unraid API versions, along with the steps to reproduce the problem.

## License

The Bridge source is licensed under **GPL-2.0-or-later**. See the [license notice](NOTICE.md) and [GPL text](LICENSE). The release package includes a separately licensed, closed-source Core executable with its license and third-party notices. Dependencies retain their own licenses, including those listed in [vendor attribution](vendor/README.md).
