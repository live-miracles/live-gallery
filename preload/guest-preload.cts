import { contextBridge, ipcRenderer } from 'electron';

type GalleryCommand =
    | { type: 'mute'; muted: boolean }
    | { type: 'audio-levels'; enabled: boolean; phaseMetricsEnabled?: boolean }
    | { type: 'auto-live'; enabled: boolean }
    | { type: 'lowest-quality' }
    | { type: 'start-screen-share'; source: DesktopSource }
    | { type: 'reset-screen-share' };

type AudioSampleBuffers = {
    left: Float32Array<ArrayBuffer>;
    right: Float32Array<ArrayBuffer>;
    phaseLeft: Float32Array<ArrayBuffer>;
    phaseRight: Float32Array<ArrayBuffer>;
};

type AudioTools = {
    context: AudioContext;
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    phaseAnalyserL: AnalyserNode;
    phaseAnalyserR: AnalyserNode;
    gain: GainNode;
    source: MediaElementAudioSourceNode;
    meterSource?: MediaStreamAudioSourceNode;
    sampleBuffers: AudioSampleBuffers;
    phaseAnalyzersConnected: boolean;
    usingCapturedMeter: boolean;
};

type StreamAudioTools = {
    context: AudioContext;
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    phaseAnalyserL: AnalyserNode;
    phaseAnalyserR: AnalyserNode;
    gain: GainNode;
    source: MediaStreamAudioSourceNode;
    sampleBuffers: AudioSampleBuffers;
    phaseAnalyzersConnected: boolean;
};

type CapturableMediaElement = HTMLMediaElement & {
    captureStream?: () => MediaStream;
};

type DesktopSource = {
    id: string;
    name: string;
    displayId: string;
    thumbnail: string;
};

type VideoHealthAlert = 'video-buffering' | 'video-repeated-buffering' | 'video-frozen';

contextBridge.exposeInMainWorld('liveGalleryGuest', {
    getDesktopSources: (): Promise<DesktopSource[]> =>
        ipcRenderer.invoke('gallery:get-desktop-sources') as Promise<DesktopSource[]>,
    connectScreenShareAudio: (): void => {
        connectScreenShareAudioFromPage();
    },
    rememberScreenShareSource: (source: DesktopSource): void => {
        ipcRenderer.sendToHost('gallery-screen-share-source', {
            id: source.id,
            name: source.name,
            displayId: source.displayId,
        });
    },
    notifyScreenShareEnded: (): void => {
        disconnectScreenShareAudio();
        ipcRenderer.sendToHost('gallery-screen-share-ended', { boxId });
    },
    openScreenSharePicker: (): void => {
        ipcRenderer.sendToHost('gallery-open-screen-share-picker');
    },
});

const params = new URLSearchParams(window.location.search);
const boxId = params.get('boxId') ?? crypto.randomUUID();
const screenShareValue = parseScreenShareValue(params.get('value') ?? '');
let audioTools: AudioTools | null = null;
let streamAudioTools: StreamAudioTools | null = null;
let muted = true;
let levelsEnabled = params.get('audioLevels') !== '0';
let autoLive = params.get('autoLive') !== '0';
let connectedElement: HTMLMediaElement | null = null;
let connectedStream: MediaStream | null = null;
let selectedMicStream: MediaStream | null = null;
let emitLevelsStarted = false;
let mediaHealthStarted = false;
let autoLiveTimer = 0;
const isScreenShare = window.location.pathname.endsWith('/screen-share.html');
let phaseMetricsEnabled = params.get('audioPhaseMetrics') !== '0';
let lastPhaseMetricsAt = 0;
const BUFF_SIZE = 64;
const PHASE_BUFF_SIZE = 4096;
const PHASE_METRICS_INTERVAL_MS = 500;
const SMOOTHING_TIME = 0.8;
const RMS_GAIN = 2.0;
const PHASE_MIN_SIGNAL_RMS = 0.0001;
const BUFFERING_ALERT_MS = 4000;
const REPEATED_BUFFERING_WINDOW_MS = 60000;
const REPEATED_BUFFERING_COUNT = 5;
const FROZEN_ALERT_MS = 8000;
const FROZEN_ALERT_MAX_MS = 60 * 1000;
const VIDEO_HEALTH_INTERVAL_MS = 500;

function parseScreenShareValue(value: string): { micDeviceId: string } {
    try {
        const parsed = JSON.parse(value) as { micDeviceId?: unknown };
        return { micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : '' };
    } catch {
        return { micDeviceId: '' };
    }
}

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
        const phaseAnalyserL = context.createAnalyser();
        const phaseAnalyserR = context.createAnalyser();
        const gain = context.createGain();

        analyserL.fftSize = BUFF_SIZE * 2;
        analyserR.fftSize = BUFF_SIZE * 2;
        phaseAnalyserL.fftSize = PHASE_BUFF_SIZE * 2;
        phaseAnalyserR.fftSize = PHASE_BUFF_SIZE * 2;
        analyserL.smoothingTimeConstant = SMOOTHING_TIME;
        analyserR.smoothingTimeConstant = SMOOTHING_TIME;
        phaseAnalyserL.smoothingTimeConstant = 0;
        phaseAnalyserR.smoothingTimeConstant = 0;

        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(gain);
        gain.connect(context.destination);

        const tools = {
            context,
            source,
            splitter,
            analyserL,
            analyserR,
            phaseAnalyserL,
            phaseAnalyserR,
            gain,
            sampleBuffers: createSampleBuffers(),
            phaseAnalyzersConnected: false,
            usingCapturedMeter: false,
        };
        syncPhaseAnalyserConnections(tools);
        attachCapturedMeterSource(tools, media);
        return tools;
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

function attachCapturedMeterSource(tools: AudioTools, media: HTMLMediaElement): void {
    if (tools.usingCapturedMeter || !media.currentSrc.startsWith('file:')) {
        return;
    }

    const stream = (media as CapturableMediaElement).captureStream?.();
    if (!stream) {
        return;
    }

    if (stream.getAudioTracks().length === 0) {
        return;
    }

    const meterSource = tools.context.createMediaStreamSource(stream);
    try {
        tools.source.disconnect(tools.splitter);
    } catch {}
    meterSource.connect(tools.splitter);
    tools.meterSource = meterSource;
    tools.usingCapturedMeter = true;
}

function syncPhaseAnalyserConnections(tools = streamAudioTools ?? audioTools): void {
    if (!tools) {
        return;
    }

    if (phaseMetricsEnabled && !tools.phaseAnalyzersConnected) {
        tools.splitter.connect(tools.phaseAnalyserL, 0);
        tools.splitter.connect(tools.phaseAnalyserR, 1);
        tools.phaseAnalyzersConnected = true;
    } else if (!phaseMetricsEnabled && tools.phaseAnalyzersConnected) {
        try {
            tools.splitter.disconnect(tools.phaseAnalyserL);
            tools.splitter.disconnect(tools.phaseAnalyserR);
        } catch {}
        tools.phaseAnalyzersConnected = false;
    }
}

function createSampleBuffers(): AudioSampleBuffers {
    return {
        left: new Float32Array(BUFF_SIZE * 2),
        right: new Float32Array(BUFF_SIZE * 2),
        phaseLeft: new Float32Array(PHASE_BUFF_SIZE * 2),
        phaseRight: new Float32Array(PHASE_BUFF_SIZE * 2),
    };
}

function readTimeDomain(
    analyser: AnalyserNode,
    data: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
    analyser.getFloatTimeDomainData(data);
    return data;
}

function calculateDbFromSamples(data: Float32Array<ArrayBuffer>): number {
    let sum = 0;
    data.forEach((sample) => {
        sum += sample * sample;
    });

    const rms = Math.sqrt(sum / data.length) * RMS_GAIN;
    return 20 * Math.log10(rms + 1e-10);
}

function calculatePhaseMetrics(
    left: Float32Array<ArrayBuffer>,
    right: Float32Array<ArrayBuffer>,
): { correlation: number; monoLossDb: number } | null {
    const length = Math.min(left.length, right.length);
    if (length === 0) {
        return null;
    }

    let sumLeft = 0;
    let sumRight = 0;
    let sumLeftSquared = 0;
    let sumRightSquared = 0;
    let sumLeftRight = 0;
    let sumMidSquared = 0;

    for (let index = 0; index < length; index += 1) {
        const leftSample = left[index] ?? 0;
        const rightSample = right[index] ?? 0;
        sumLeft += leftSample;
        sumRight += rightSample;
        sumLeftSquared += leftSample * leftSample;
        sumRightSquared += rightSample * rightSample;
        sumLeftRight += leftSample * rightSample;
        sumMidSquared += ((leftSample + rightSample) / 2) ** 2;
    }

    const meanLeft = sumLeft / length;
    const meanRight = sumRight / length;
    const leftVariance = sumLeftSquared / length - meanLeft * meanLeft;
    const rightVariance = sumRightSquared / length - meanRight * meanRight;
    const covariance = sumLeftRight / length - meanLeft * meanRight;
    const leftRms = Math.sqrt(sumLeftSquared / length);
    const rightRms = Math.sqrt(sumRightSquared / length);

    if (
        leftVariance <= Number.EPSILON ||
        rightVariance <= Number.EPSILON ||
        leftRms < PHASE_MIN_SIGNAL_RMS ||
        rightRms < PHASE_MIN_SIGNAL_RMS
    ) {
        return null;
    }

    const db = (value: number): number => 20 * Math.log10(value + 1e-10);
    const correlation = covariance / Math.sqrt(leftVariance * rightVariance);
    const monoRms = Math.sqrt(sumMidSquared / length);
    const monoLossDb = db(monoRms) - (db(leftRms) + db(rightRms)) / 2;

    return { correlation, monoLossDb };
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
        const leftSamples = readTimeDomain(tools.analyserL, tools.sampleBuffers.left);
        const rightSamples = readTimeDomain(tools.analyserR, tools.sampleBuffers.right);
        const now = performance.now();
        const shouldReadPhaseMetrics =
            phaseMetricsEnabled && now - lastPhaseMetricsAt >= PHASE_METRICS_INTERVAL_MS;
        const phaseMetrics = shouldReadPhaseMetrics
            ? calculatePhaseMetrics(
                  readTimeDomain(tools.phaseAnalyserL, tools.sampleBuffers.phaseLeft),
                  readTimeDomain(tools.phaseAnalyserR, tools.sampleBuffers.phaseRight),
              )
            : null;
        if (shouldReadPhaseMetrics) {
            lastPhaseMetricsAt = now;
        }
        const payload = {
            boxId,
            left: calculateDbFromSamples(leftSamples),
            right: calculateDbFromSamples(rightSamples),
        };
        if (!phaseMetricsEnabled) {
            ipcRenderer.sendToHost('gallery-level', {
                ...payload,
                correlation: null,
                monoLossDb: null,
            });
        } else if (shouldReadPhaseMetrics) {
            ipcRenderer.sendToHost('gallery-level', {
                ...payload,
                correlation: phaseMetrics?.correlation ?? null,
                monoLossDb: phaseMetrics?.monoLossDb ?? null,
            });
        } else {
            ipcRenderer.sendToHost('gallery-level', payload);
        }
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

    const deviceId = screenShareValue.micDeviceId;
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

    disconnectScreenShareAudio(false);

    try {
        const context = new AudioContext();
        const source = context.createMediaStreamSource(new MediaStream(audioTracks));
        const splitter = context.createChannelSplitter(2);
        const analyserL = context.createAnalyser();
        const analyserR = context.createAnalyser();
        const phaseAnalyserL = context.createAnalyser();
        const phaseAnalyserR = context.createAnalyser();
        const gain = context.createGain();

        analyserL.fftSize = BUFF_SIZE * 2;
        analyserR.fftSize = BUFF_SIZE * 2;
        phaseAnalyserL.fftSize = PHASE_BUFF_SIZE * 2;
        phaseAnalyserR.fftSize = PHASE_BUFF_SIZE * 2;
        analyserL.smoothingTimeConstant = SMOOTHING_TIME;
        analyserR.smoothingTimeConstant = SMOOTHING_TIME;
        phaseAnalyserL.smoothingTimeConstant = 0;
        phaseAnalyserR.smoothingTimeConstant = 0;

        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        source.connect(gain);
        gain.connect(context.destination);

        streamAudioTools = {
            context,
            source,
            splitter,
            analyserL,
            analyserR,
            phaseAnalyserL,
            phaseAnalyserR,
            gain,
            sampleBuffers: createSampleBuffers(),
            phaseAnalyzersConnected: false,
        };
        syncPhaseAnalyserConnections(streamAudioTools);
        applyMute();
        startLevelLoop();
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function disconnectScreenShareAudio(stopMic = true): void {
    streamAudioTools?.source.disconnect();
    streamAudioTools?.gain.disconnect();
    streamAudioTools?.context.close().catch(() => {});
    streamAudioTools = null;

    if (stopMic) {
        selectedMicStream?.getTracks().forEach((track) => track.stop());
        selectedMicStream = null;
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
        attachCapturedMeterSource(audioTools, media);
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
    startMediaHealthLoop(media);

    if (isScreenShare) {
        window.addEventListener('live-gallery-media-ready', connectScreenShareAudioFromPage);
        return;
    }

    connectMedia(media);
    window.addEventListener('live-gallery-media-ready', () => {
        connectMedia(media);
    });
}

function sendVideoHealth(kind: VideoHealthAlert, active: boolean): void {
    ipcRenderer.sendToHost('gallery-health', {
        boxId,
        kind,
        active,
    });
}

function startMediaHealthLoop(media: HTMLMediaElement): void {
    if (mediaHealthStarted) {
        return;
    }

    mediaHealthStarted = true;
    let hasStarted = false;
    let bufferingSince = 0;
    let lastTime = media.currentTime;
    let lastTimeChangedAt = performance.now();
    let bufferingActive = false;
    let wasBuffering = false;
    let repeatedBufferingActive = false;
    let bufferingEvents: number[] = [];
    let frozenActive = false;

    const markStarted = (): void => {
        hasStarted = true;
        lastTime = media.currentTime;
        lastTimeChangedAt = performance.now();
    };

    media.addEventListener('playing', markStarted);
    media.addEventListener('timeupdate', () => {
        if (media.currentTime !== lastTime) {
            hasStarted = true;
            lastTime = media.currentTime;
            lastTimeChangedAt = performance.now();
        }
    });

    window.setInterval(() => {
        const now = performance.now();
        const expectedPlaying = hasStarted && !media.paused && !media.ended;
        const isBuffering = expectedPlaying && media.readyState < media.HAVE_FUTURE_DATA;

        if (isBuffering) {
            bufferingSince ||= now;
        } else {
            bufferingSince = 0;
        }

        if (isBuffering && !wasBuffering) {
            bufferingEvents.push(now);
        }
        wasBuffering = isBuffering;
        bufferingEvents = bufferingEvents.filter(
            (eventTime) => now - eventTime <= REPEATED_BUFFERING_WINDOW_MS,
        );

        const nextRepeatedBufferingActive = bufferingEvents.length >= REPEATED_BUFFERING_COUNT;
        if (nextRepeatedBufferingActive !== repeatedBufferingActive) {
            repeatedBufferingActive = nextRepeatedBufferingActive;
            sendVideoHealth('video-repeated-buffering', repeatedBufferingActive);
        }

        const nextBufferingActive =
            Boolean(bufferingSince) && now - bufferingSince >= BUFFERING_ALERT_MS;
        if (nextBufferingActive !== bufferingActive) {
            bufferingActive = nextBufferingActive;
            sendVideoHealth('video-buffering', bufferingActive);
        }

        const frozenForMs = now - lastTimeChangedAt;
        const nextFrozenActive =
            expectedPlaying &&
            !nextBufferingActive &&
            frozenForMs >= FROZEN_ALERT_MS &&
            frozenForMs <= FROZEN_ALERT_MAX_MS;
        if (nextFrozenActive !== frozenActive) {
            frozenActive = nextFrozenActive;
            sendVideoHealth('video-frozen', frozenActive);
        }
    }, VIDEO_HEALTH_INTERVAL_MS);
}

function clickAutoLive(): void {
    if (!autoLive) {
        return;
    }

    const liveBadge = querySelectorAllShadows<HTMLElement>('.ytwPlayerTimeDisplayTimeElapsed')[0];
    if (!liveBadge) {
        console.error('YouTube auto-live failed: live badge element was not found.');
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
    const settingsButton = querySelectorAllShadows<HTMLElement>('.player-settings-icon')[0];
    if (!settingsButton) {
        console.error('YouTube set quality failed: settings button was not found.');
        return;
    }

    settingsButton.click();
    await sleep(300);

    const menuItems = querySelectorAllShadows<HTMLElement>('.ytListItemViewModelTitle');
    const qualityItem = menuItems.find((item) =>
        item.textContent?.toLowerCase().includes('quality'),
    );
    if (!qualityItem) {
        console.error('YouTube set quality failed: quality item was not found in the menu.');
        return;
    }
    qualityItem?.click();
    await sleep(300);

    const qualityOptions = querySelectorAllShadows<HTMLElement>('.ytListItemViewModelTitle').filter(
        (item) => {
            const text = item.textContent ?? '';
            return /\d+p/i.test(text) && !/\bauto\b/i.test(text);
        },
    );
    if (qualityOptions.length === 0) {
        console.error('YouTube set quality failed: no quality options were found.');
        return;
    }

    const lowest = qualityOptions[qualityOptions.length - 1];
    lowest?.click();
}

ipcRenderer.on('gallery-command', (_event, command: GalleryCommand) => {
    if (command.type === 'mute') {
        muted = command.muted;
        applyMute();
    } else if (command.type === 'audio-levels') {
        levelsEnabled = command.enabled;
        phaseMetricsEnabled = command.phaseMetricsEnabled ?? phaseMetricsEnabled;
        syncPhaseAnalyserConnections();
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
    } else if (command.type === 'start-screen-share') {
        window.dispatchEvent(
            new CustomEvent('live-gallery-start-screen-share', { detail: command.source }),
        );
    } else if (command.type === 'reset-screen-share') {
        disconnectScreenShareAudio();
        window.dispatchEvent(new CustomEvent('live-gallery-reset-screen-share'));
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        ipcRenderer.sendToHost('gallery-escape');
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
