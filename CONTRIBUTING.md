# Contributing to Live Gallery

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

## Ask or suggest first

- **Questions, setup help, ideas:** start a thread in [Discussions](https://github.com/live-miracles/live-gallery/discussions).
- **Bugs:** [open an issue](https://github.com/live-miracles/live-gallery/issues/new/choose). Include your operating system, the Live Gallery version (visible on the release you installed), the source type (YouTube, JW Player, HLS, ...), and what you expected to happen.
- For a larger change, such as a new source type or a new alert, open a discussion or issue before writing code so we can agree on the approach.

## Run it from source

You need Node.js 22 or newer.

```bash
npm ci
npm run dev
```

`npm run dev` starts the CSS and TypeScript watchers and Electron with hot reload. The code is split into `backend/` (Electron main process), `preload/` (bridges to the pages) and `frontend/` (the gallery UI and alerts).

## Before you open a pull request

```bash
npm run format   # Prettier
npm test         # builds, then runs the Node test suite
```

CI runs `npm run format:check` and `npm test` on every push and pull request.

A good pull request:

- does one thing, with a description of the problem and how you checked the fix;
- adds or updates a test when it changes logic that can be tested without a window;
- includes a screenshot or short recording for visible changes;
- keeps alert thresholds documented in the Settings dialog when it changes them.

## Releases

Maintainers publish releases by pushing a version tag; see the Publishing section of the [README](README.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
