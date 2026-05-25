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
    copyText: (text: string): Promise<void> =>
        ipcRenderer.invoke('gallery:copy-text', text) as Promise<void>,
    toggleFullscreen: (): Promise<void> =>
        ipcRenderer.invoke('gallery:toggle-fullscreen') as Promise<void>,
    reload: (): Promise<void> => ipcRenderer.invoke('gallery:reload') as Promise<void>,
    exportPreset: (boxes: PresetBox[]): Promise<boolean> =>
        ipcRenderer.invoke('gallery:export-preset', boxes) as Promise<boolean>,
    importPreset: (): Promise<PresetBox[] | null> =>
        ipcRenderer.invoke('gallery:import-preset') as Promise<PresetBox[] | null>,
    listPresets: (): Promise<SavedPreset[]> =>
        ipcRenderer.invoke('gallery:list-presets') as Promise<SavedPreset[]>,
    savePreset: (name: string, boxes: PresetBox[]): Promise<SavedPreset[]> =>
        ipcRenderer.invoke('gallery:save-preset', name, boxes) as Promise<SavedPreset[]>,
    renamePreset: (oldName: string, newName: string): Promise<SavedPreset[]> =>
        ipcRenderer.invoke('gallery:rename-preset', oldName, newName) as Promise<SavedPreset[]>,
    deletePreset: (name: string): Promise<SavedPreset[]> =>
        ipcRenderer.invoke('gallery:delete-preset', name) as Promise<SavedPreset[]>,
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

type PresetBox = {
    name: string;
    type: string;
    value: string;
};

type SavedPreset = {
    name: string;
    boxes: PresetBox[];
};
