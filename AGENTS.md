# Agent Guide

## Project overview

Live Gallery is an Electron desktop app (TypeScript) for monitoring many live streams in one window: a box per source (YouTube, JW Player, VdoCipher, HLS, custom URLs, local files, screen shares), a live audio meter on each, solo/rotate audio, and alerts for frozen video, silence, clipping and phase problems. Windows is the primary, tested platform; the macOS (Apple Silicon `.dmg`) and Linux (`.AppImage`) builds are beta. Keep that wording consistent wherever platforms are mentioned.

It only watches streams and sits outside the production path, so it is not critical infrastructure (unlike Bunryu, which runs live production directly). A bug can be fixed in the next release; favor shipping improvements over heavy caution, but keep the app responsive with dozens of boxes.

## Code map

Navigation only; correct an entry when a change makes it stale, and add one only for a new module.

- `backend/main.ts` - Electron main process: window, menus and shortcuts, auto-update, IPC, saved presets, opening external links in the browser. `window-state.ts` remembers display, position and full-screen state.
- `preload/preload.cts` - bridge that exposes `window.liveGallery` to the app page. `preload/guest-preload.cts` runs inside every box's webview: audio metering (Web Audio), media health, mute and mono output, and the YouTube commands (auto live, max volume, lowest quality).
- `frontend/app.ts` - the gallery UI: toolbar, boxes, settings, rotation, toasts. `alerts.ts` has every alert threshold, the overlay, the five-minute history and the beep. `presets.ts` is the Preset menu. `utils.ts` has the box and settings types and builds each player URL. `fit-layout.ts` picks the box size for Fit (tested in `fit-layout.test.ts`). `icons.ts` is the SVG icon set.
- `frontend/*.html` - `index.html` is the app page; `local-file-player.html`, `m3u8-player.html` and `screen-share.html` are the pages loaded into boxes.
- `frontend/input.css` - Tailwind plus the app's own components (buttons, fields, switches, menus, dialogs) and design tokens: Apple-style dark materials with a Hokusai palette and seigaiha wave pattern. `fonts/` bundles Inter (OFL); `images/great-wave.avif` is a dark ukiyo-e wave nightscape inspired by Hokusai's waves, shown in empty boxes and on the Screen Share page before a window is chosen.
- `docs/` - user documentation (see below). `README.md` is the pitch and install steps.

## Documentation

The docs are published on the org site (`live-miracles.github.io`, `/projects/live-gallery/docs/`), which renders `README.md` and `docs/` from this repo; the app's Docs button opens that page. `docs/` is numbered section folders of numbered pages, indexed in `docs/README.md`; link between pages with relative `.md` links.

**Documentation is part of every change.** When you add or change a feature, alert, threshold or setting, update every page that describes it in the same change (search `docs/` and `README.md` for its name). Remove or correct text the change makes wrong; don't just append. A stale statement is worse than a missing one. Alert thresholds in `docs/3-reference/1-alerts.md` and the Settings dialog must match `frontend/alerts.ts`.

**Keep the docs concise.** Readers are users, and the docs answer two questions only: what can this app do (so someone curious learns about features they didn't know existed), and how do I do the non-obvious things.

- Don't explain what the UI already makes obvious: no button-by-button tours, no "click X to do X". Mention a control only when it hides something worth knowing.
- Do highlight features a new user wouldn't guess: importing a wall from YouTube links, rotating audio over a box range, the phase-mismatch alert, monitoring Zoom through a virtual audio cable.
- State thresholds and limits exactly; leave out implementation detail.
- Say each thing once, in the page it belongs to, and link to it from elsewhere. No changelog-style narration or speculative options.

CI fails on a broken relative link or anchor in `README.md` or `docs/`, and on a docs page that `docs/README.md` does not link to. The checker lives in the org site repository; with a sibling checkout, run `node ../live-miracles.github.io/scripts/check-docs.js .` before committing doc changes. To preview the rendered pages, run `LOCAL_PROJECTS=live-gallery=../live-gallery npm run dev` in the site repository.

Releases carry one installer per platform plus the updater metadata (`electron-builder` config in `package.json`); don't add targets without reason, since a long asset list confuses new users.

## Pre-commit checks

Review the complete diff before committing, looking for bugs, regressions and unintended changes. Run `npm run format:check` for every change, including docs and UI, and `npm test` (builds, then runs the Node tests) for any code change. A change that only touches docs, comments or cosmetic styling skips the test suite; run the format check and, for docs, the link checker.

For UI changes, run `npm run dev` and look at the result; type checks and tests do not show layout problems.

Never run `git push` (or force-push, tag, or open/merge a PR) unless the user explicitly asks for it in that request; committing stays local. Pushing a `v*` tag publishes a release.

**This repository is public on GitHub.** Never commit stream URLs with embedded keys, tokens, `.env` contents or personal data, in code, docs or test fixtures.
