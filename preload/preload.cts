import { contextBridge, ipcRenderer } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

contextBridge.exposeInMainWorld('liveGallery', {
    guestPreloadUrl: pathToFileURL(path.join(__dirname, 'guest-preload.cjs')).toString(),
    getZoom: (): Promise<number> => ipcRenderer.invoke('gallery:get-zoom') as Promise<number>,
    setZoom: (percent: number): Promise<number> =>
        ipcRenderer.invoke('gallery:set-zoom', percent) as Promise<number>,
    changeZoom: (delta: number): Promise<number> =>
        ipcRenderer.invoke('gallery:change-zoom', delta) as Promise<number>,
    onZoomChanged: (callback: (percent: number) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, percent: number): void => {
            callback(percent);
        };
        ipcRenderer.on('gallery:zoom-changed', listener);
        return () => ipcRenderer.removeListener('gallery:zoom-changed', listener);
    },
    onUpdateAvailable: (callback: () => void): (() => void) => {
        const listener = (): void => callback();
        ipcRenderer.on('gallery:update-available', listener);
        return () => ipcRenderer.removeListener('gallery:update-available', listener);
    },
    onUpdateProgress: (callback: (progress: number) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: number): void => {
            callback(progress);
        };
        ipcRenderer.on('gallery:update-progress', listener);
        return () => ipcRenderer.removeListener('gallery:update-progress', listener);
    },
    onUpdateReady: (callback: () => void): (() => void) => {
        const listener = (): void => callback();
        ipcRenderer.on('gallery:update-ready', listener);
        return () => ipcRenderer.removeListener('gallery:update-ready', listener);
    },
    downloadUpdate: (): void => ipcRenderer.send('gallery:download-update'),
    installUpdate: (): void => ipcRenderer.send('gallery:install-update'),
});
