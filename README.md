<img src="frontend/logo.png" alt="Live Gallery logo" width="96" align="right" />

# Live Gallery

_Open-source multiviewer for live streams: watch many at once, hear the one that matters, and get alerted when one breaks._

[![CI](https://github.com/live-miracles/live-gallery/actions/workflows/ci.yml/badge.svg)](https://github.com/live-miracles/live-gallery/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/live-miracles/live-gallery)](https://github.com/live-miracles/live-gallery/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-live--miracles.github.io-blue.svg)](https://live-miracles.github.io/projects/live-gallery/)

**Live Gallery is a desktop app for monitoring many live streams in one window.** Put YouTube, JW Player, HLS and other players side by side, see a live audio meter on every box, solo or rotate the audio between them, and let the app warn you about frozen video, silence, clipping and broken stereo before your viewers do.

It was built by a team that streams large live events to viewers around the world, where one bad feed among twenty is easy to miss. The installers are free and nothing needs to be installed besides the app. Windows is the primary, tested platform; macOS and Linux builds are in beta.

| [Download](#download) | [Documentation](docs/README.md) | [Get help](https://github.com/live-miracles/live-gallery/discussions) | [Report a bug](https://github.com/live-miracles/live-gallery/issues/new/choose) |
| --------------------- | ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |

<img width="1372" height="380" alt="Live Gallery showing several live streams with audio meters" src="https://github.com/user-attachments/assets/61a912f2-2a03-4cb1-afeb-b618fc6ad01b" />

**Who it's for:** stream operators, AV and church-tech teams, newsrooms and anyone who has to keep an eye on several live feeds at once, such as the main stream, its backups and each language channel. **Who it isn't for:** recording or restreaming (it only watches), or a hosted service (it runs on your computer).

## Features

- **Many sources, one window.** Add YouTube (including privacy-enhanced `youtube-nocookie`), JW Player, VdoCipher, HLS (`.m3u8`) and other embeddable pages as custom URLs, local files, and screen shares with a chosen audio input, which also covers Zoom and any other desktop app. Drag boxes to reorder them.
- **Audio meters on every box.** Separate left and right levels, so you can see a one-sided or silent feed at a glance.
- **Mute, solo and rotate.** Hear one stream at a time, or turn on rotation to move the audio across boxes you pick (for example `1 3 5-8`) every few seconds.
- **Alerts that catch real problems.** Every alert is switchable, has a documented threshold, and keeps a five-minute history:
    - Video: buffering, repeated buffering, frozen picture.
    - Audio: silence, dropouts, clipping, one channel missing, left/right level imbalance, and phase mismatch (left and right cancelling out when played in mono).
    - An optional alert beep with its own volume control.
- **Player commands.** Jump YouTube players to LIVE or to the lowest fixed quality in one click.
- **Presets.** Save and load layouts, export them as JSON, or paste a list of YouTube links to build a wall in seconds.
- **Built for long shifts.** Box zoom up to 1000%, an interface size setting for accessibility, a stereo/mono output switch, and the app reopens on the same display, position and full-screen state.

## Why the audio checks matter

During one live event, a suspected faulty audio embedder made the left and right channels cancel each other. Both meters were moving and the left channel sounded fine, yet more than 20 streams had broken audio for viewers. The phase mismatch and channel alerts exist because of that incident. Read the story: [One faulty audio embedder disrupted 20 live streams](https://live-miracles.github.io/blog/one-faulty-embedder-20-streams/).

## Monitor Zoom or any desktop app

Anything you can see on your screen can be a box, so Live Gallery also works with Zoom meetings, webinars and other apps that have no embeddable player. Add a **Screen Share** box, pick the window, and use a virtual audio cable ([VB-Cable](https://vb-audio.com/Cable/) on Windows, [BlackHole](https://existential.audio/blackhole/) on macOS) so Live Gallery can listen to the audio. The step-by-step guide is in [Monitor Zoom or any desktop app](docs/2-usage/5-monitor-zoom.md).

## Download

You do not need to install Node.js or download the source code to use it.

1. Open the [Live Gallery Releases page](https://github.com/live-miracles/live-gallery/releases/latest).
2. Under **Assets**, download the **one** file for your system and ignore the rest (`latest*.yml` and `.blockmap` files are only used by the app's automatic updater):

    | System                     | Download                  | Status              |
    | -------------------------- | ------------------------- | ------------------- |
    | Windows 10/11 (64-bit)     | `…-windows-x64.exe`       | Recommended, tested |
    | macOS (Apple Silicon: M1+) | `…-macos-arm64.dmg`       | Beta                |
    | Linux (64-bit)             | `…-linux-x86_64.AppImage` | Beta                |

3. Open the downloaded file and follow the installation steps. On Linux, make the AppImage executable first (`chmod +x`).

### Platform support

Live Gallery is built and tested on **Windows**. The macOS and Linux builds are **beta**: they are published so you can try them, but they have had little testing, so expect rough edges and please [report what you find](https://github.com/live-miracles/live-gallery/issues/new/choose). There is no build for Intel Macs; on those, or on other Linux packages such as `.deb`, you can [run it from source](CONTRIBUTING.md).

The installers are not code-signed yet, so Windows SmartScreen or macOS Gatekeeper may warn you the first time. On Windows choose **More info → Run anyway**. On macOS, right-click the app and choose **Open**.

## Quick start

1. Copy a stream link and press **Ctrl V** anywhere in the window (Cmd V on macOS). It fills the first empty box, or adds one; paste several links, one per line, to add several boxes at once.
2. For JW Player, VdoCipher or an address you type, use **Other…** on an empty box (**+** adds one).
3. Use the headphones button on a box to solo it, or enable **Rotate audio** to cycle through boxes.
4. Open **Settings** to choose which alerts are on. The Alerts button shows active alerts and the last five minutes of history.

The full guides are in the [documentation](docs/README.md), also reachable from the **Docs** button in the app.

## Get help and give feedback

- **Questions and ideas:** [GitHub Discussions](https://github.com/live-miracles/live-gallery/discussions).
- **Bugs:** [open an issue](https://github.com/live-miracles/live-gallery/issues/new/choose) with your operating system, the Live Gallery version and the source type involved.
- **More projects from the team:** [live-miracles.github.io](https://live-miracles.github.io/) lists the rest of the open-source streaming tools we use, such as [Bunryu](https://live-miracles.github.io/projects/bunryu/) for restreaming.

If Live Gallery is useful to you, a star on GitHub helps other stream operators find it.

## Contributing

Contributions are welcome, from typo fixes to new source types. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the app from source and what a good pull request looks like.

## Development

Install dependencies, build TypeScript/CSS, then start the Electron app in watch
mode:

```bash
npm ci
npm run dev
```

Useful scripts:

```bash
npm run build         # Compile CSS, backend, preload, and frontend code
npm run dev           # Build and run CSS/TypeScript watchers and Electron in development with hot reload
npm test              # Build, then run the Node test suite
npm run format        # Format the project with Prettier
npm run format:check  # Check formatting without changing files
```

## Packaging

Create a local installer for the current platform in `release/`:

```bash
npm run dist
```

## Publishing

Publishing uses Electron Builder's GitHub publisher configuration from
`package.json`. Releases are published automatically when a version tag is
pushed to GitHub.

```bash
npm version x.x.x
git push origin master --tags
```

The tag push starts the release workflow, builds installers on Windows, macOS,
and Linux, and publishes them to a GitHub release for that tag. Each release
carries one installer per platform (Windows `.exe`, macOS Apple Silicon `.dmg`,
Linux x64 `.AppImage`) plus the metadata files the auto-updater needs.

## License

[MIT](LICENSE) © Live Stream Miracles
