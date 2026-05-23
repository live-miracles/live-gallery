import { ipcRenderer } from 'electron';

type GalleryCommand =
    | { type: 'mute'; muted: boolean }
    | { type: 'audio-levels'; enabled: boolean }
    | { type: 'auto-live'; enabled: boolean }
    | { type: 'lowest-quality' };

type AudioTools = {
    context: AudioContext;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    gain: GainNode;
    source?: MediaElementAudioSourceNode;
};

const params = new URLSearchParams(window.location.search);
const boxId = params.get('boxId') ?? crypto.randomUUID();
let audioTools: AudioTools | null = null;
let muted = true;
let levelsEnabled = params.get('audioLevels') !== '0';
let autoLive = params.get('autoLive') !== '0';
let connectedElement: HTMLMediaElement | null = null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function querySelectorAllShadows<T extends Element>(
    selector: string,
    root: ParentNode = document,
): T[] {
    const direct = Array.from(root.querySelectorAll<T>(selector));
    const shadowResults = Array.from(root.querySelectorAll('*'))
        .map((element) => element.shadowRoot)
        .filter((shadowRoot): shadowRoot is ShadowRoot => Boolean(shadowRoot))
        .flatMap((shadowRoot) => querySelectorAllShadows<T>(selector, shadowRoot));

    return [...direct, ...shadowResults];
}

async function waitForVideo(): Promise<HTMLMediaElement | null> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const video = querySelectorAllShadows<HTMLMediaElement>('video, audio')[0];
        if (video) {
            return video;
        }
        await sleep(500);
    }

    return null;
}

function createTools(media: HTMLMediaElement): AudioTools | null {
    try {
        const context = new AudioContext();
        const source = context.createMediaElementSource(media);
        const splitter = context.createChannelSplitter(2);
        const analyserL = context.createAnalyser();
        const analyserR = context.createAnalyser();
        const gain = context.createGain();

        analyserL.fftSize = 256;
        analyserR.fftSize = 256;
        analyserL.smoothingTimeConstant = 0.8;
        analyserR.smoothingTimeConstant = 0.8;

        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(gain);
        gain.connect(context.destination);

        return { context, source, analyserL, analyserR, gain };
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

function calculateDb(analyser: AnalyserNode): number {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);

    const sum = data.reduce((total, sample) => total + sample * sample, 0);
    const rms = Math.sqrt(sum / data.length) * 2.3;
    return Math.max(-90, Math.min(0, 20 * Math.log10(rms + 1e-10)));
}

function applyMute(): void {
    if (audioTools) {
        audioTools.gain.gain.value = muted ? 0 : 1;
        audioTools.context.resume().catch((error: unknown) => {
            ipcRenderer.sendToHost('gallery-error', {
                boxId,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }
}

function emitLevels(): void {
    if (audioTools && levelsEnabled) {
        ipcRenderer.sendToHost('gallery-level', {
            boxId,
            left: calculateDb(audioTools.analyserL),
            right: calculateDb(audioTools.analyserR),
        });
    }

    window.setTimeout(emitLevels, 100);
}

function keepMediaAudibleForMeter(media: HTMLMediaElement): void {
    media.autoplay = true;
    media.muted = false;
    media.volume = 1;
}

function clickAutoLive(): void {
    if (!autoLive) {
        return;
    }

    const liveBadge = querySelectorAllShadows<HTMLElement>('.ytp-live-badge')[0];
    if (liveBadge && !liveBadge.classList.contains('ytp-live-badge-is-live')) {
        liveBadge.click();
    }
}

async function setLowestYouTubeQuality(): Promise<void> {
    const settingsButton = querySelectorAllShadows<HTMLElement>('.ytp-settings-button')[0];
    if (!settingsButton) {
        return;
    }

    settingsButton.click();
    await sleep(300);

    const menuItems = querySelectorAllShadows<HTMLElement>('.ytp-menuitem');
    const qualityItem = menuItems.find((item) =>
        item.textContent?.toLowerCase().includes('quality'),
    );
    qualityItem?.click();
    await sleep(300);

    const qualityOptions = querySelectorAllShadows<HTMLElement>('.ytp-menuitem').filter((item) =>
        /\d+p|auto/i.test(item.textContent ?? ''),
    );
    const lowest = qualityOptions[qualityOptions.length - 1];
    lowest?.click();
}

ipcRenderer.on('gallery-command', (_event, command: GalleryCommand) => {
    if (command.type === 'mute') {
        muted = command.muted;
        applyMute();
    } else if (command.type === 'audio-levels') {
        levelsEnabled = command.enabled;
    } else if (command.type === 'auto-live') {
        autoLive = command.enabled;
    } else if (command.type === 'lowest-quality') {
        setLowestYouTubeQuality().catch((error: unknown) => {
            ipcRenderer.sendToHost('gallery-error', {
                boxId,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }
});

window.addEventListener('DOMContentLoaded', () => {
    waitForVideo()
        .then((media) => {
            if (!media || connectedElement === media) {
                return;
            }

            connectedElement = media;
            keepMediaAudibleForMeter(media);
            audioTools = createTools(media);
            applyMute();
            emitLevels();
            window.setInterval(() => keepMediaAudibleForMeter(media), 500);
            window.setInterval(clickAutoLive, 2000);
        })
        .catch((error: unknown) => {
            ipcRenderer.sendToHost('gallery-error', {
                boxId,
                message: error instanceof Error ? error.message : String(error),
            });
        });
});
