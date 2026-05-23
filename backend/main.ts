import { app, BrowserWindow, Menu, MenuItemConstructorOptions, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import updater from 'electron-updater';
const { autoUpdater } = updater;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const youtubeEmbedOrigin = 'https://live-gallery.local';

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
    win.setMenuBarVisibility(false);

    win.webContents.on('before-input-event', (event, input) => {
        const isDevToolsShortcut =
            input.key === 'F12' ||
            (input.control && input.shift && input.key.toLowerCase() === 'i');
        if (isDevToolsShortcut && input.type === 'keyDown') {
            event.preventDefault();
            win.webContents.toggleDevTools();
        }
    });

    win.loadFile(path.join(rootDir, 'frontend', 'index.html'));

    // For Camera / Mic permissions
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            callback(true);
        } else {
            callback(false);
        }
    });

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
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
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
