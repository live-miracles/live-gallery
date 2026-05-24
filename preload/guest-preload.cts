import { contextBridge, ipcRenderer } from 'electron';

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

type StreamAudioTools = {
    context: AudioContext;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    gain: GainNode;
    source: MediaStreamAudioSourceNode;
};

type DesktopSource = {
    id: string;
    name: string;
    thumbnail: string;
};

contextBridge.exposeInMainWorld('liveGalleryGuest', {
    getDesktopSources: (): Promise<DesktopSource[]> =>
        ipcRenderer.invoke('gallery:get-desktop-sources') as Promise<DesktopSource[]>,
    connectScreenShareAudio: (): void => {
        connectScreenShareAudioFromPage();
    },
});

const params = new URLSearchParams(window.location.search);
const boxId = params.get('boxId') ?? crypto.randomUUID();
let audioTools: AudioTools | null = null;
let streamAudioTools: StreamAudioTools | null = null;
let muted = true;
let levelsEnabled = params.get('audioLevels') !== '0';
let autoLive = params.get('autoLive') !== '0';
let connectedElement: HTMLMediaElement | null = null;
let connectedStream: MediaStream | null = null;
let selectedMicStream: MediaStream | null = null;
let emitLevelsStarted = false;
let autoLiveTimer = 0;
const isScreenShare = window.location.pathname.endsWith('/screen-share.html');
const BUFF_SIZE = 64;
const SMOOTHING_TIME = 0.8;
const RMS_GAIN = 2.3;

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

        analyserL.fftSize = BUFF_SIZE * 2;
        analyserR.fftSize = BUFF_SIZE * 2;
        analyserL.smoothingTimeConstant = SMOOTHING_TIME;
        analyserR.smoothingTimeConstant = SMOOTHING_TIME;

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
    const rms = Math.sqrt(sum / data.length) * RMS_GAIN;
    return 20 * Math.log10(rms + 1e-10);
}

function resumeContext(context: AudioContext): void {
    context.resume().catch((error: unknown) => {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
    });
}

function applyMute(): void {
    if (audioTools) {
        audioTools.gain.gain.value = muted ? 0 : 1;
        resumeContext(audioTools.context);
    }

    if (streamAudioTools) {
        streamAudioTools.gain.gain.value = muted ? 0 : 1;
        resumeContext(streamAudioTools.context);
    }
}

function emitLevels(): void {
    const tools = streamAudioTools ?? audioTools;
    if (tools && levelsEnabled) {
        ipcRenderer.sendToHost('gallery-level', {
            boxId,
            left: calculateDb(tools.analyserL),
            right: calculateDb(tools.analyserR),
        });
    }

    window.setTimeout(emitLevels, 100);
}

function startLevelLoop(): void {
    if (emitLevelsStarted) {
        return;
    }

    emitLevelsStarted = true;
    emitLevels();
}

function getCleanMicConstraints(deviceId: string): MediaTrackConstraints {
    return {
        deviceId: { exact: deviceId },
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2,
    };
}

async function connectSelectedScreenShareMic(): Promise<void> {
    if (!isScreenShare || selectedMicStream) {
        return;
    }

    const deviceId = params.get('value');
    if (!deviceId) {
        return;
    }

    try {
        selectedMicStream = await navigator.mediaDevices.getUserMedia({
            audio: getCleanMicConstraints(deviceId),
            video: false,
        });
        connectScreenShareAudio(selectedMicStream);
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function connectScreenShareAudio(stream: MediaStream): void {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
        return;
    }

    streamAudioTools?.source.disconnect();
    streamAudioTools?.gain.disconnect();
    streamAudioTools?.context.close().catch(() => {});

    try {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(new MediaStream(audioTracks));
        const splitter = context.createChannelSplitter(2);
        const analyserL = context.createAnalyser();
        const analyserR = context.createAnalyser();
        const gain = context.createGain();

        analyserL.fftSize = BUFF_SIZE * 2;
        analyserR.fftSize = BUFF_SIZE * 2;
        analyserL.smoothingTimeConstant = SMOOTHING_TIME;
        analyserR.smoothingTimeConstant = SMOOTHING_TIME;

        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(gain);
        gain.connect(context.destination);

        streamAudioTools = { context, source, analyserL, analyserR, gain };
        applyMute();
        startLevelLoop();
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function connectScreenShareAudioFromPage(): void {
    const media = querySelectorAllShadows<HTMLMediaElement>('video, audio')[0];
    const stream = media?.srcObject;
    if (!(stream instanceof MediaStream)) {
        return;
    }

    media.muted = true;
    media.volume = 0;
    connectScreenShareAudio(stream);
}

function keepMediaAudibleForMeter(media: HTMLMediaElement): void {
    media.autoplay = true;
    media.muted = false;
    media.volume = 1;
}

function connectMedia(media: HTMLMediaElement): void {
    const stream = media.srcObject instanceof MediaStream ? media.srcObject : null;
    if (isScreenShare) {
        return;
    }

    if (connectedElement === media && audioTools) {
        connectedStream = stream;
        keepMediaAudibleForMeter(media);
        applyMute();
        return;
    }

    keepMediaAudibleForMeter(media);
    connectedElement = media;
    connectedStream = stream;
    audioTools = createTools(media);
    applyMute();
    startLevelLoop();
}

function watchMedia(media: HTMLMediaElement): void {
    if (isScreenShare) {
        window.addEventListener('live-gallery-media-ready', connectScreenShareAudioFromPage);
        return;
    }

    connectMedia(media);
    window.addEventListener('live-gallery-media-ready', () => {
        connectMedia(media);
    });
    window.setInterval(() => {
        keepMediaAudibleForMeter(media);
        connectMedia(media);
    }, 500);
}

function clickAutoLive(): void {
    if (!autoLive) {
        return;
    }

    const liveBadge = querySelectorAllShadows<HTMLElement>('.ytwPlayerTimeDisplayTimeElapsed')[0];
    if (!liveBadge) {
        console.error('YouTube auto-live failed: .ytp-live-badge was not found.');
        return;
    }

    liveBadge.click();
}

function startAutoLiveLoop(): void {
    window.clearInterval(autoLiveTimer);
    if (!autoLive || isScreenShare) {
        return;
    }

    clickAutoLive();
    autoLiveTimer = window.setInterval(clickAutoLive, 5000);
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
        startAutoLiveLoop();
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
    connectSelectedScreenShareMic().catch((error: unknown) => {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
    });

    waitForVideo()
        .then((media) => {
            if (!media) {
                return;
            }

            watchMedia(media);
            startAutoLiveLoop();
        })
        .catch((error: unknown) => {
            ipcRenderer.sendToHost('gallery-error', {
                boxId,
                message: error instanceof Error ? error.message : String(error),
            });
        });
});
