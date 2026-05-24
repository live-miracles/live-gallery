import {
    app,
    BrowserWindow,
    desktopCapturer,
    ipcMain,
    Menu,
    MenuItemConstructorOptions,
    session,
    shell,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import updater from 'electron-updater';
const { autoUpdater } = updater;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const youtubeEmbedOrigin = 'https://live-gallery.local';
const zoomStepPercent = 10;
const minZoomPercent = 20;
const maxZoomPercent = 300;
let appZoomPercent = 100;
const shortcutWebContents = new WeakSet<Electron.WebContents>();

ipcMain.handle('gallery:get-zoom', () => appZoomPercent);
ipcMain.handle('gallery:set-zoom', (_event, percent: number) => setAppZoom(percent));
ipcMain.handle('gallery:change-zoom', (_event, delta: number) =>
    changeAppZoom(delta * zoomStepPercent),
);

ipcMain.handle('gallery:get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 240, height: 135 },
        fetchWindowIcons: true,
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
    }));
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

    installAppShortcuts(win, win.webContents);

    win.loadFile(path.join(rootDir, 'frontend', 'index.html'));

    if (isSmokeTest) {
        win.webContents.once('did-finish-load', () => {
            app.exit(0);
        });
        setTimeout(() => app.exit(0), 5000).unref();
    }
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
                    click: () => changeAppZoom(zoomStepPercent),
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => changeAppZoom(-zoomStepPercent),
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

        const zoomDirection = getZoomDirection(input);
        if (zoomDirection !== null) {
            event.preventDefault();
            if (zoomDirection === 0) {
                setAppZoom(100);
            } else {
                changeAppZoom(zoomDirection * zoomStepPercent);
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

function changeAppZoom(deltaPercent: number): number {
    return setAppZoom(appZoomPercent + deltaPercent);
}

function setAppZoom(percent: number): number {
    appZoomPercent = Math.max(
        minZoomPercent,
        Math.min(maxZoomPercent, Math.round(percent / zoomStepPercent) * zoomStepPercent),
    );
    BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.setZoomFactor(appZoomPercent / 100);
        win.webContents.send('gallery:zoom-changed', appZoomPercent);
    });
    return appZoomPercent;
}

function configureAppSession(): void {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
            urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
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

    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
            console.warn('Update check failed:', error);
        });
    }

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
