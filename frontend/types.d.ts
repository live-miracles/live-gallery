export {};

declare global {
    interface Window {
        liveGallery: {
            guestPreloadUrl: string;
            getZoom: () => Promise<number>;
            setZoom: (percent: number) => Promise<number>;
            changeZoom: (delta: number) => Promise<number>;
            onZoomChanged: (callback: (percent: number) => void) => () => void;
        };
    }
}
