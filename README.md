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

## Removal

1. Open your Unraid Web UI and go to **Plugins → Installed Plugins**.
2. Find **Unraid Deck Bridge** (`unraid-deck-bridge`).
3. Click **Remove**, confirm, and wait for removal to finish.

Removal deletes Bridge's settings and task history, but does not delete existing Docker containers, images, volumes, or user templates. The official API may restart briefly during removal.

## License

Bridge source is **GPL-2.0-or-later**; see [LICENSE](LICENSE). Third-party components retain their own licenses; see [vendor attribution](vendor/README.md).
