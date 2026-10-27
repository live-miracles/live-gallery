import { contextBridge, ipcRenderer, webFrame } from 'electron';

type GalleryCommand =
    | { type: 'mute'; muted: boolean }
    | { type: 'audio-levels'; enabled: boolean; phaseMetricsEnabled?: boolean }
    | { type: 'mono-output'; enabled: boolean }
    | { type: 'auto-live'; enabled: boolean }
    | { type: 'lowest-quality' }
    | { type: 'max-volume' }
    | { type: 'start-screen-share'; source: DesktopSource }
    | { type: 'reset-screen-share' };

type AudioSampleBuffers = {
    left: Float32Array<ArrayBuffer>;
    right: Float32Array<ArrayBuffer>;
};

type AudioTools = {
    context: AudioContext;
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    gain: GainNode;
    source: MediaElementAudioSourceNode;
    meterSource?: MediaStreamAudioSourceNode;
    sampleBuffers: AudioSampleBuffers;
    usingCapturedMeter: boolean;
};

type StreamAudioTools = {
    context: AudioContext;
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    gain: GainNode;
    source: MediaStreamAudioSourceNode;
    sampleBuffers: AudioSampleBuffers;
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
let monoOutput = params.get('monoOutput') === '1';
let autoLive = params.get('autoLive') !== '0';
let connectedElement: HTMLMediaElement | null = null;
let connectedStream: MediaStream | null = null;
let selectedMicStream: MediaStream | null = null;
let emitLevelsStarted = false;
let mediaHealthStarted = false;
let autoLiveTimer = 0;
let lastUserInputAt = -Infinity;
let userInputTrackingStarted = false;
const boostedMedia = new WeakSet<HTMLMediaElement>();
const USER_VOLUME_INPUT_WINDOW_MS = 1500;
const isScreenShare = window.location.pathname.endsWith('/screen-share.html');
let phaseMetricsEnabled = params.get('audioPhaseMetrics') !== '0';
let lastPhaseMetricsAt = 0;
// Levels are sample peaks in dBFS, like vMix. Each read covers ~170 ms at 48 kHz, longer
// than the read interval, so no peak can fall between two reads. Phase metrics reuse
// the same samples instead of a second pair of analysers.
const LEVEL_FFT_SIZE = 8192;
const LEVEL_INTERVAL_MS = 100;
const PHASE_METRICS_INTERVAL_MS = 500;
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
        const { splitter, analyserL, analyserR } = createMeterNodes(context);
        const gain = context.createGain();

        source.connect(splitter);
        source.connect(gain);
        gain.connect(context.destination);

        const tools = {
            context,
            source,
            splitter,
            analyserL,
            analyserR,
            gain,
            sampleBuffers: createSampleBuffers(),
            usingCapturedMeter: false,
        };
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

function createMeterNodes(context: AudioContext): {
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
} {
    const splitter = context.createChannelSplitter(2);
    const analyserL = context.createAnalyser();
    const analyserR = context.createAnalyser();
    analyserL.fftSize = LEVEL_FFT_SIZE;
    analyserR.fftSize = LEVEL_FFT_SIZE;
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    return { splitter, analyserL, analyserR };
}

function createSampleBuffers(): AudioSampleBuffers {
    return {
        left: new Float32Array(LEVEL_FFT_SIZE),
        right: new Float32Array(LEVEL_FFT_SIZE),
    };
}

function readTimeDomain(
    analyser: AnalyserNode,
    data: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> {
    analyser.getFloatTimeDomainData(data);
    return data;
}

function calculatePeakDb(data: Float32Array<ArrayBuffer>): number {
    let peak = 0;
    for (let index = 0; index < data.length; index += 1) {
        const sample = Math.abs(data[index] ?? 0);
        if (sample > peak) {
            peak = sample;
        }
    }

    return 20 * Math.log10(peak + 1e-10);
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

function applyOutputChannels(gain: GainNode): void {
    // A 1-channel explicit node downmixes stereo to (L + R) / 2; the destination
    // then upmixes it back so both speakers carry the same mono signal.
    gain.channelCountMode = monoOutput ? 'explicit' : 'max';
    gain.channelCount = monoOutput ? 1 : 2;
}

function applyMute(): void {
    if (audioTools) {
        applyOutputChannels(audioTools.gain);
        audioTools.gain.gain.value = muted ? 0 : 1;
        resumeContext(audioTools.context);
    }

    if (streamAudioTools) {
        applyOutputChannels(streamAudioTools.gain);
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
            ? calculatePhaseMetrics(leftSamples, rightSamples)
            : null;
        if (shouldReadPhaseMetrics) {
            lastPhaseMetricsAt = now;
        }
        const payload = {
            boxId,
            left: calculatePeakDb(leftSamples),
            right: calculatePeakDb(rightSamples),
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

    window.setTimeout(emitLevels, LEVEL_INTERVAL_MS);
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
        const { splitter, analyserL, analyserR } = createMeterNodes(context);
        const gain = context.createGain();

        source.connect(splitter);
        source.connect(gain);
        gain.connect(context.destination);

        streamAudioTools = {
            context,
            source,
            splitter,
            analyserL,
            analyserR,
            gain,
            sampleBuffers: createSampleBuffers(),
        };
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

function noteUserInput(): void {
    lastUserInputAt = performance.now();
}

function startUserInputTracking(): void {
    if (userInputTrackingStarted) {
        return;
    }

    userInputTrackingStarted = true;
    const note = (event: Event): void => {
        if (event.isTrusted) {
            noteUserInput();
        }
    };
    const notePointerMove = (event: PointerEvent): void => {
        // Dragging the player's volume slider keeps changing the volume while the button is held.
        if (event.isTrusted && event.buttons !== 0) {
            noteUserInput();
        }
    };
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'wheel', 'touchstart']) {
        window.addEventListener(type, note, { capture: true, passive: true });
    }
    window.addEventListener('pointermove', notePointerMove, { capture: true, passive: true });
}

// The YouTube player keeps its own volume (restored from its saved level) and reapplies it to
// the media element, so the element alone is not enough: raise the player's level as well.
// The player object lives in the page's world, which this isolated preload cannot call.
function raiseYouTubePlayerVolume(): void {
    webFrame
        .executeJavaScript(
            `(() => {
                const player = document.getElementById('movie_player');
                if (player?.getVolume && (player.getVolume() < 100 || player.isMuted())) {
                    player.unMute();
                    player.setVolume(100);
                }
            })()`,
        )
        .catch(() => {});
}

function raiseMediaVolume(media: HTMLMediaElement): void {
    media.muted = false;
    media.volume = 1;
    raiseYouTubePlayerVolume();
}

// The embedded player often starts quiet (it restores its own saved level, or autoplays
// muted). Lift it to full and keep lifting any change the page makes on its own, until the
// user changes the volume through the player's own controls; after that it is theirs.
function keepMediaAudibleForMeter(media: HTMLMediaElement): void {
    media.autoplay = true;
    raiseMediaVolume(media);

    if (boostedMedia.has(media)) {
        return;
    }

    boostedMedia.add(media);
    startUserInputTracking();
    let userAdjusted = false;
    media.addEventListener('volumechange', () => {
        if (performance.now() - lastUserInputAt < USER_VOLUME_INPUT_WINDOW_MS) {
            userAdjusted = true;
        } else if (!userAdjusted && (media.muted || media.volume !== 1)) {
            raiseMediaVolume(media);
        }
    });
    // The player can reapply its saved level without touching the element's volume.
    const timer = window.setInterval(() => {
        if (userAdjusted) {
            window.clearInterval(timer);
        } else {
            raiseYouTubePlayerVolume();
        }
    }, 1000);
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
    } else if (command.type === 'mono-output') {
        monoOutput = command.enabled;
        applyMute();
    } else if (command.type === 'auto-live') {
        autoLive = command.enabled;
        startAutoLiveLoop();
    } else if (command.type === 'max-volume') {
        if (connectedElement) {
            raiseMediaVolume(connectedElement);
        }
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
