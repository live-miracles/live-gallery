# Live Gallery

Live Gallery is an Electron app for monitoring multiple live sources at once:
YouTube, privacy-enhanced YouTube embeds, JW Player, VdoCipher, Facebook embeds,
custom URLs, HLS links, and screen shares.

<img width="1372" height="380" alt="image" src="https://github.com/user-attachments/assets/61a912f2-2a03-4cb1-afeb-b618fc6ad01b" />

## Download

Live Gallery is available for Windows, macOS, and Linux. You do not need to
install Node.js or download the source code to use it.

1. Open the [Live Gallery Releases page](https://github.com/live-miracles/live-gallery/releases).
2. Open the newest release at the top of the page.
3. Under **Assets**, download the installer for your platform:
    - Windows: `windows-x64.exe`
    - macOS Intel: `macos-x64.dmg` (or `macos-x64.zip`)
    - macOS Apple Silicon: `macos-arm64.dmg` (or `macos-arm64.zip`)
    - Linux: `linux-x64.AppImage`
    - Debian-based Linux: `linux-x64.deb`
4. Open the downloaded file and follow the installation steps.

After installation, start Live Gallery from the Start menu or its desktop
shortcut. If GitHub shows the release notes collapsed, click **Assets** to see
the installer download.

For support, please [open a GitHub issue](https://github.com/live-miracles/live-gallery/issues).

## Features

- Monitor several live players in one desktop window.
- Add YouTube, YouTube no-cookie, JW Player, VdoCipher, HLS, custom URL,
  and screen-share boxes.
- Mute, solo, and rotate audio between boxes.
- Show audio levels for active streams.
- Send supported player commands, including YouTube LIVE and lowest fixed quality.
- Package and publish Windows, macOS, and Linux installers with Electron
  Builder.

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
and Linux, and publishes them to a GitHub release for that tag.
