# Live Gallery

Live Gallery is an Electron app for monitoring multiple live sources at once:
YouTube, privacy-enhanced YouTube embeds, JW Player, VdoCipher, Facebook embeds,
custom URLs, HLS links, and screen shares.

## Features

- Monitor several live players in one desktop window.
- Add YouTube, YouTube no-cookie, JW Player, VdoCipher, HLS, custom URL,
  and screen-share boxes.
- Mute, solo, and rotate audio between boxes.
- Show audio levels for active streams.
- Send supported player commands, including YouTube LIVE and lowest fixed quality.
- Package and publish Windows installers with Electron Builder.

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

Create a local installer in `release/`:

```bash
npm run dist
```

## Publishing

Publishing uses Electron Builder's GitHub publisher configuration from
`package.json`. Put the required publishing credentials in `.env`, then run:

```bash
npm run publish
```

The publish script builds the app and runs Electron Builder with
`--publish=always`, so the generated release artifact is uploaded to the
configured GitHub repository.
