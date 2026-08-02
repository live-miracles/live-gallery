import {
    app,
    BrowserWindow,
    clipboard,
    desktopCapturer,
    dialog,
    ipcMain,
    Menu,
    MenuItemConstructorOptions,
    session,
    shell,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import updater from 'electron-updater';
const { autoUpdater } = updater;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const youtubeEmbedOrigin = 'https://live-gallery.local';
const minZoomPercent = 20;
const maxZoomPercent = 300;
const presetsFileName = 'presets.json';
const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;
let appZoomPercent = 100;
const shortcutWebContents = new WeakSet<Electron.WebContents>();
let updatesAreConfigured = false;

configureChromiumSwitches();

ipcMain.handle('gallery:get-zoom', () => appZoomPercent);
ipcMain.handle('gallery:set-zoom', (_event, percent: number) => setAppZoom(percent));
ipcMain.handle('gallery:get-content-width', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.getContentBounds().width ?? 0;
});
ipcMain.handle('gallery:copy-text', (_event, text: string) => {
    clipboard.writeText(text);
});
ipcMain.handle('gallery:toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setFullScreen(!win.isFullScreen());
});
ipcMain.handle('gallery:reload', (event) => {
    event.sender.reload();
});
ipcMain.handle('gallery:export-preset', async (event, boxes: PresetBox[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
        defaultPath: 'live-gallery.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
        return false;
    }

    await fs.writeFile(result.filePath, JSON.stringify(normalizePresetBoxes(boxes), null, 2));
    return true;
});
ipcMain.handle('gallery:import-preset', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
    };
    const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    return readPresetFile(result.filePaths[0]);
});
ipcMain.handle('gallery:import-preset-from-clipboard', () => {
    const raw = clipboard.readText();
    if (!raw.trim()) {
        return null;
    }

    return parseClipboardPreset(raw);
});
ipcMain.handle('gallery:list-presets', () => readSavedPresets());
ipcMain.handle('gallery:save-preset', async (_event, name: string, boxes: PresetBox[]) => {
    const presetName = normalizePresetName(name);
    if (!presetName) {
        throw new Error('Preset name is required.');
    }

    const presets = await readSavedPresets();
    const existing = presets.find(
        (preset) => preset.name.toLowerCase() === presetName.toLowerCase(),
    );
    if (existing) {
        existing.boxes = normalizePresetBoxes(boxes);
    } else {
        presets.push({ name: presetName, boxes: normalizePresetBoxes(boxes) });
    }
    await writeSavedPresets(presets);
    return sortPresets(presets);
});
ipcMain.handle('gallery:rename-preset', async (_event, oldName: string, newName: string) => {
    const presetName = normalizePresetName(newName);
    if (!presetName) {
        throw new Error('Preset name is required.');
    }

    const presets = await readSavedPresets();
    const preset = presets.find((item) => item.name === oldName);
    if (!preset) {
        return sortPresets(presets);
    }

    preset.name = presetName;
    await writeSavedPresets(presets);
    return sortPresets(presets);
});
ipcMain.handle('gallery:delete-preset', async (_event, name: string) => {
    const presets = (await readSavedPresets()).filter((preset) => preset.name !== name);
    await writeSavedPresets(presets);
    return sortPresets(presets);
});
ipcMain.on('gallery:download-update', () => {
    autoUpdater.downloadUpdate().catch((error: unknown) => {
        console.warn('Update download failed:', error);
    });
});
ipcMain.on('gallery:install-update', () => autoUpdater.quitAndInstall());

ipcMain.handle('gallery:get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 240, height: 135 },
        fetchWindowIcons: true,
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        displayId: source.display_id,
        thumbnail: source.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('gallery:select-local-media-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
        filters: [
            {
                name: 'Audio and video',
                extensions: [
                    'aac',
                    'aif',
                    'aiff',
                    'avi',
                    'flac',
                    'm4a',
                    'm4v',
                    'mkv',
                    'mov',
                    'mp3',
                    'mp4',
                    'mpeg',
                    'mpg',
                    'oga',
                    'ogg',
                    'opus',
                    'wav',
                    'weba',
                    'webm',
                    'wmv',
                ],
            },
        ],
        properties: ['openFile'],
    };
    const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    return pathToFileURL(result.filePaths[0]).toString();
});

function createWindow(): void {
    const isSmokeTest = process.argv.includes('--smoke-test');
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        title: `Live Gallery ${app.getVersion()}`,
        icon: path.join(rootDir, 'frontend', 'logo-256.ico'),
        backgroundColor: '#101418',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webviewTag: true,
        },
    });
    win.setAutoHideMenuBar(true);
    win.setMenu(null);
    win.setMenuBarVisibility(false);

    installAppShortcuts(win, win.webContents);

    win.loadFile(path.join(rootDir, 'frontend', 'index.html'));
    win.webContents.once('did-finish-load', () => {
        syncAppZoomFromWindow(win);
    });
    setupUpdates(win);

    if (isSmokeTest) {
        win.webContents.once('did-finish-load', () => {
            app.exit(0);
        });
        setTimeout(() => app.exit(0), 5000).unref();
    }
}

function setupUpdates(win: BrowserWindow): void {
    autoUpdater.autoDownload = false;

    if (!app.isPackaged) {
        return;
    }

    win.webContents.once('did-finish-load', () => {
        autoUpdater.checkForUpdates().catch((error: unknown) => {
            console.warn('Update check failed:', error);
        });
    });

    if (updatesAreConfigured) {
        return;
    }

    updatesAreConfigured = true;

    autoUpdater.on('update-available', () => {
        broadcastToWindows('gallery:update-available');
    });

    autoUpdater.on('download-progress', (progress) => {
        broadcastToWindows('gallery:update-progress', progress.percent);
    });

    autoUpdater.on('update-downloaded', () => {
        broadcastToWindows('gallery:update-ready');
    });
}

function broadcastToWindows(channel: string, ...args: unknown[]): void {
    BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send(channel, ...args);
    });
}

function createApplicationMenu(): void {
    const template: MenuItemConstructorOptions[] = [
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                {
                    label: 'Actual Size',
                    accelerator: 'CmdOrCtrl+0',
                    click: () => setAppZoom(100),
                },
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+=',
                    click: () => changeAppZoomStep(1),
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => changeAppZoomStep(-1),
                },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
    ];

    if (process.platform === 'darwin') {
        template.unshift({
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
        });
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installAppShortcuts(win: BrowserWindow, contents: Electron.WebContents): void {
    if (shortcutWebContents.has(contents)) {
        return;
    }

    shortcutWebContents.add(contents);
    contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return;
        }

        if (isDevToolsShortcut(input)) {
            event.preventDefault();
            win.webContents.toggleDevTools();
            return;
        }

        if (input.key === 'F11') {
            event.preventDefault();
            win.setFullScreen(!win.isFullScreen());
            return;
        }

        if (isShortcutModifier(input) && input.key.toLowerCase() === 'r') {
            event.preventDefault();
            contents.reload();
            return;
        }

        const zoomDirection = getZoomDirection(input);
        if (zoomDirection !== null) {
            event.preventDefault();
            if (zoomDirection === 0) {
                setAppZoom(100);
            } else {
                changeAppZoomStep(zoomDirection);
            }
        }
    });
}

function isShortcutModifier(input: Electron.Input): boolean {
    return process.platform === 'darwin' ? input.meta : input.control;
}

function isDevToolsShortcut(input: Electron.Input): boolean {
    return input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
}

function getZoomDirection(input: Electron.Input): -1 | 0 | 1 | null {
    if (!isShortcutModifier(input) || input.alt) {
        return null;
    }

    const key = input.key.toLowerCase();
    const isPlus = ['+', '=', 'add'].includes(key);
    const isMinus = ['-', '_', 'subtract'].includes(key);
    const isReset = key === '0';

    if (input.shift && !isPlus) {
        return null;
    }

    if (isReset) {
        return 0;
    }
    if (isPlus) {
        return 1;
    }
    if (isMinus) {
        return -1;
    }

    return null;
}

function changeAppZoomStep(direction: -1 | 1): number {
    const step = direction > 0 ? (appZoomPercent >= 100 ? 10 : 5) : appZoomPercent > 100 ? 10 : 5;
    const nextZoom =
        direction > 0
            ? Math.floor(appZoomPercent / step) * step + step
            : Math.ceil(appZoomPercent / step) * step - step;
    return setAppZoom(nextZoom);
}

function syncAppZoomFromWindow(win: BrowserWindow): void {
    appZoomPercent = Math.round(win.webContents.getZoomFactor() * 100);
    win.webContents.send('gallery:zoom-changed', appZoomPercent);
}

function setAppZoom(percent: number): number {
    appZoomPercent = Math.max(minZoomPercent, Math.min(maxZoomPercent, Math.round(percent)));
    BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setZoomFactor(appZoomPercent / 100);
        win.webContents.send('gallery:zoom-changed', appZoomPercent);
    });
    return appZoomPercent;
}

type PresetBox = {
    name: string;
    type: string;
    value: string;
};

type SavedPreset = {
    name: string;
    boxes: PresetBox[];
};

function getPresetsPath(): string {
    return path.join(app.getPath('userData'), presetsFileName);
}

function normalizePresetName(name: string): string {
    return name.trim().replace(/[\\/:*?"<>|]/g, '-');
}

function normalizePresetBoxes(value: unknown): PresetBox[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map((box) => {
        const item = box as Partial<PresetBox>;
        return {
            name: String(item.name ?? ''),
            type: String(item.type ?? 'YT'),
            value: String(item.value ?? ''),
        };
    });
}

function parseClipboardPreset(raw: string): PresetBox[] {
    try {
        return normalizePresetBoxes(JSON.parse(raw) as unknown);
    } catch {
        const boxes = parseYouTubePresetLines(raw);
        if (boxes.length > 0) {
            return boxes;
        }
        throw new Error('Clipboard does not contain a preset or YouTube links.');
    }
}

function parseYouTubePresetLines(raw: string): PresetBox[] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => parseYouTubePresetLine(line, index))
        .filter((box): box is PresetBox => Boolean(box));
}

function parseYouTubePresetLine(line: string, index: number): PresetBox | null {
    const match = line.match(
        /\b(?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com)|youtu\.be)\/\S+/i,
    );
    const candidate = (match?.[0] ?? line).replace(/[),.;]+$/, '');
    const videoId = extractYouTubeId(candidate);
    if (!youtubeIdPattern.test(videoId)) {
        return null;
    }

    const name = match ? line.slice(0, match.index).trim() : '';
    return {
        name: name || String(index + 1),
        type: 'YT',
        value: videoId,
    };
}

function extractYouTubeId(input: string): string {
    const trimmed = input.trim();
    try {
        const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
        const videoParam = url.searchParams.get('v');
        if (videoParam && youtubeIdPattern.test(videoParam)) {
            return videoParam;
        }

        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        const isYouTubeHost =
            hostname === 'youtube.com' ||
            hostname.endsWith('.youtube.com') ||
            hostname === 'youtube-nocookie.com' ||
            hostname.endsWith('.youtube-nocookie.com');
        const pathId = url.pathname
            .split('/')
            .filter(Boolean)
            .find((segment, index, segments) => {
                if (hostname === 'youtu.be') {
                    return index === 0 && youtubeIdPattern.test(segment);
                }

                return (
                    isYouTubeHost &&
                    ['embed', 'live', 'shorts', 'v'].includes(segments[index - 1] ?? '') &&
                    youtubeIdPattern.test(segment)
                );
            });

        if (pathId) {
            return pathId;
        }
    } catch {
        return trimmed;
    }

    return trimmed;
}

function sortPresets(presets: SavedPreset[]): SavedPreset[] {
    return presets.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
}

async function readPresetFile(filePath: string): Promise<PresetBox[]> {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizePresetBoxes(JSON.parse(raw) as unknown);
}

async function readSavedPresets(): Promise<SavedPreset[]> {
    try {
        const raw = await fs.readFile(getPresetsPath(), 'utf8');
        const value = JSON.parse(raw) as unknown;
        if (!Array.isArray(value)) {
            return [];
        }
        return sortPresets(
            value
                .map((preset) => {
                    const item = preset as Partial<SavedPreset>;
                    return {
                        name: String(item.name ?? ''),
                        boxes: normalizePresetBoxes(item.boxes),
                    };
                })
                .filter((preset) => preset.name.trim()),
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeSavedPresets(presets: SavedPreset[]): Promise<void> {
    await fs.mkdir(path.dirname(getPresetsPath()), { recursive: true });
    await fs.writeFile(getPresetsPath(), JSON.stringify(sortPresets(presets), null, 2));
}

function configureChromiumSwitches(): void {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
    app.commandLine.appendSwitch(
        'disable-features',
        [
            'WebRtcAllowInputVolumeAdjustment',
            'WebRtcApmDownmixCaptureAudioMethod',
            'ChromeWideEchoCancellation',
        ].join(','),
    );
}

function configureAppSession(): void {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-read']);
        callback(allowed.has(permission));
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders ?? {};
        delete headers['X-Frame-Options'];
        delete headers['x-frame-options'];
        delete headers['Content-Security-Policy'];
        delete headers['content-security-policy'];
        callback({ responseHeaders: headers });
    });

    session.defaultSession.webRequest.onBeforeSendHeaders(
        {
            urls: ['*://*.youtube.com/*'],
        },
        (details, callback) => {
            callback({
                requestHeaders: {
                    ...details.requestHeaders,
                    Referer: `${youtubeEmbedOrigin}/`,
                },
            });
        },
    );
}

app.whenReady().then(() => {
    configureAppSession();
    createApplicationMenu();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('web-contents-created', (_event, contents) => {
    const hostWebContents = (
        contents as Electron.WebContents & {
            hostWebContents?: Electron.WebContents;
        }
    ).hostWebContents;
    const ownerWindow =
        BrowserWindow.fromWebContents(contents) ??
        BrowserWindow.fromWebContents(hostWebContents ?? contents);
    if (ownerWindow) {
        installAppShortcuts(ownerWindow, contents);
        if (contents !== ownerWindow.webContents) {
            contents.setZoomFactor(1);
            contents.on('did-navigate', () => contents.setZoomFactor(1));
        }
    }

    contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url).catch((error: unknown) => {
            console.warn('Could not open external URL:', error);
        });
        return { action: 'deny' };
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
