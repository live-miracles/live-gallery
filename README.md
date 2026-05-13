# Live Gallery

Live Gallery is an Electron app for monitoring multiple live sources at once:
YouTube, privacy-enhanced YouTube embeds, JW Player, VdoCipher, Facebook embeds,
custom URLs, HLS links, and screen shares.

The old Chrome extension flow has been replaced with Electron `webview` preloads.
Each box runs its player inside a webview, while the app can still meter audio,
mute or solo boxes, rotate the active audio source, and send player actions such
as YouTube LIVE / lowest-quality commands where the embedded player allows it.

## Development

```bash
npm ci
npm run build
npm run dev
```

## Packaging

```bash
npm run dist
```
