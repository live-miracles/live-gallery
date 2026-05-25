export {};

declare global {
    type PresetBox = {
        name: string;
        type: string;
        value: string;
    };

    type SavedPreset = {
        name: string;
        boxes: PresetBox[];
    };

    interface Window {
        liveGallery: {
            guestPreloadUrl: string;
            getZoom: () => Promise<number>;
            setZoom: (percent: number) => Promise<number>;
            changeZoom: (delta: number) => Promise<number>;
            copyText: (text: string) => Promise<void>;
            toggleFullscreen: () => Promise<void>;
            reload: () => Promise<void>;
            exportPreset: (boxes: PresetBox[]) => Promise<boolean>;
            importPreset: () => Promise<PresetBox[] | null>;
            listPresets: () => Promise<SavedPreset[]>;
            savePreset: (name: string, boxes: PresetBox[]) => Promise<SavedPreset[]>;
            renamePreset: (oldName: string, newName: string) => Promise<SavedPreset[]>;
            deletePreset: (name: string) => Promise<SavedPreset[]>;
            onZoomChanged: (callback: (percent: number) => void) => () => void;
            onUpdateAvailable: (callback: () => void) => () => void;
            onUpdateProgress: (callback: (progress: number) => void) => () => void;
            onUpdateReady: (callback: () => void) => () => void;
            downloadUpdate: () => void;
            installUpdate: () => void;
        };
    }
}
