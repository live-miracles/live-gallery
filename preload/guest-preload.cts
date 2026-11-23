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

type MediaSourceNodes = {
    source: MediaElementAudioSourceNode;
    meterSource?: MediaStreamAudioSourceNode;
};

// One graph per box. Every audible <video> or <audio> element in the page is a source into
// it, so the meter reads their mix.
type AudioTools = {
    context: AudioContext;
    splitter: ChannelSplitterNode;
    analyserL: AnalyserNode;
    analyserR: AnalyserNode;
    gain: GainNode;
    sources: Map<HTMLMediaElement, MediaSourceNodes>;
    sampleBuffers: AudioSampleBuffers;
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

type WebAudioLevels = {
    left: number;
    right: number;
    phase: { correlation: number; monoLossDb: number } | null;
    at: number;
};

type WebAudioTapOptions = {
    mono: boolean;
    fftSize: number;
    intervalMs: number;
    phaseIntervalMs: number;
    levelEvent: string;
    controlEvent: string;
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
        // The audio channel is a separate device and stays metered, so levels resume when
        // whatever feeds it (Zoom, say) comes back, without choosing the window again.
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
let watchedMedia: HTMLMediaElement | null = null;
let switchHealthMedia: (next: HTMLMediaElement) => void = () => {};
let autoLiveTimer = 0;
let lastUserInputAt = -Infinity;
let userInputTrackingStarted = false;
let webAudioLevels: WebAudioLevels | null = null;
const boostedMedia = new WeakSet<HTMLMediaElement>();
// Events between this world and the page's, for the Web Audio tap.
const WEB_AUDIO_LEVEL_EVENT = 'live-gallery-web-audio-levels';
const WEB_AUDIO_CONTROL_EVENT = 'live-gallery-web-audio-control';
const WEB_AUDIO_STALE_MS = 500;
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
// A box counts as playing only while its playback time keeps moving. The same 8 s as the
// frozen alert, so a stuck picture never looks live.
const PLAYBACK_STALE_MS = FROZEN_ALERT_MS;
// How often to check that the watched element is still in the page: one property read.
const MEDIA_RECHECK_MS = 2000;
// How often to search the whole page for other media elements (see recheckMedia). The
// search walks every element, so it stays rare; playing and volume events cover the usual
// cases sooner.
const MEDIA_SCAN_MS = 15000;

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

function findMediaElements(): HTMLMediaElement[] {
    return querySelectorAllShadows<HTMLMediaElement>('video, audio');
}

function isPlaying(media: HTMLMediaElement): boolean {
    return !media.paused && !media.ended;
}

// A muted element (a decorative looping video, say) makes no sound, so it never counts.
function isAudiblyPlaying(media: HTMLMediaElement): boolean {
    return isPlaying(media) && !media.muted && media.volume > 0;
}

// The element the box's health checks follow: one that is making sound, else one that is
// playing, else the first in the page.
function pickMedia(candidates: HTMLMediaElement[]): HTMLMediaElement | undefined {
    return candidates.find(isAudiblyPlaying) ?? candidates.find(isPlaying) ?? candidates[0];
}

async function waitForVideo(): Promise<HTMLMediaElement | null> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const media = pickMedia(findMediaElements());
        if (media) {
            return media;
        }
        await sleep(500);
    }

    return null;
}

function createTools(): AudioTools | null {
    try {
        const context = new AudioContext();
        const { splitter, analyserL, analyserR } = createMeterNodes(context);
        const gain = context.createGain();
        gain.connect(context.destination);

        return {
            context,
            splitter,
            analyserL,
            analyserR,
            gain,
            sources: new Map(),
            sampleBuffers: createSampleBuffers(),
        };
    } catch (error) {
        ipcRenderer.sendToHost('gallery-error', {
            boxId,
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

// Throws if the element cannot be routed, e.g. the page already built its own Web Audio
// graph on it.
function addMediaSource(tools: AudioTools, media: HTMLMediaElement): void {
    let nodes = tools.sources.get(media);
    if (!nodes) {
        const source = tools.context.createMediaElementSource(media);
        source.connect(tools.splitter);
        source.connect(tools.gain);
        nodes = { source };
        tools.sources.set(media, nodes);
    }

    attachCapturedMeterSource(tools, media, nodes);
}

function attachCapturedMeterSource(
    tools: AudioTools,
    media: HTMLMediaElement,
    nodes: MediaSourceNodes,
): void {
    if (nodes.meterSource || !media.currentSrc.startsWith('file:')) {
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
        nodes.source.disconnect(tools.splitter);
    } catch {}
    meterSource.connect(tools.splitter);
    nodes.meterSource = meterSource;
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

    window.dispatchEvent(
        new CustomEvent(WEB_AUDIO_CONTROL_EVENT, { detail: { muted, mono: monoOutput } }),
    );
}

// Levels of the page's own Web Audio output, read by the tap in the page's world (see
// installWebAudioTap). Older than this and the page has gone quiet.
function currentWebAudioLevels(): WebAudioLevels | null {
    return webAudioLevels && performance.now() - webAudioLevels.at < WEB_AUDIO_STALE_MS
        ? webAudioLevels
        : null;
}

function emitLevels(): void {
    const tools = streamAudioTools ?? audioTools;
    const webLevels = currentWebAudioLevels();
    if ((tools || webLevels) && levelsEnabled) {
        const now = performance.now();
        const shouldReadPhaseMetrics =
            phaseMetricsEnabled && now - lastPhaseMetricsAt >= PHASE_METRICS_INTERVAL_MS;
        let left = -Infinity;
        let right = -Infinity;
        let phaseMetrics: { correlation: number; monoLossDb: number } | null = null;
        if (tools) {
            const leftSamples = readTimeDomain(tools.analyserL, tools.sampleBuffers.left);
            const rightSamples = readTimeDomain(tools.analyserR, tools.sampleBuffers.right);
            left = calculatePeakDb(leftSamples);
            right = calculatePeakDb(rightSamples);
            if (shouldReadPhaseMetrics) {
                phaseMetrics = calculatePhaseMetrics(leftSamples, rightSamples);
            }
        }
        // The meter shows the loudest of the page's elements and its Web Audio output. Stereo
        // phase comes from the elements, or from Web Audio when only that has a signal.
        if (webLevels) {
            left = Math.max(left, webLevels.left);
            right = Math.max(right, webLevels.right);
            if (shouldReadPhaseMetrics && !phaseMetrics) {
                phaseMetrics = webLevels.phase;
            }
        }
        if (shouldReadPhaseMetrics) {
            lastPhaseMetricsAt = now;
        }
        const payload = { boxId, left, right };
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

    disconnectScreenShareAudio();

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

// Tears down the meter graph only. The selected audio device stays open for the life of
// the page, so the meter can be rebuilt from it.
function disconnectScreenShareAudio(): void {
    streamAudioTools?.source.disconnect();
    streamAudioTools?.gain.disconnect();
    streamAudioTools?.context.close().catch(() => {});
    streamAudioTools = null;
}

function connectScreenShareAudioFromPage(): void {
    const media = findMediaElements()[0];
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

// Elements the page removed are dead; release their nodes.
function dropRemovedMedia(tools: AudioTools): void {
    for (const [media, nodes] of tools.sources) {
        if (!media.isConnected) {
            nodes.meterSource?.disconnect();
            nodes.source.disconnect();
            tools.sources.delete(media);
        }
    }
}

// Elements that could not be routed are not retried every check.
const unroutableMedia = new WeakSet<HTMLMediaElement>();

// Any other element in the page that starts making sound joins the meter. Routing happens
// only then, since a routed element can no longer play through the page's own output.
function routeAudibleMedia(tools: AudioTools, candidates: HTMLMediaElement[]): void {
    for (const media of candidates) {
        if (tools.sources.has(media) || unroutableMedia.has(media) || !isAudiblyPlaying(media)) {
            continue;
        }

        try {
            addMediaSource(tools, media);
        } catch {
            unroutableMedia.add(media);
        }
    }
}

function connectMedia(media: HTMLMediaElement): void {
    if (isScreenShare) {
        return;
    }

    keepMediaAudibleForMeter(media);
    connectedElement = media;
    connectedStream = media.srcObject instanceof MediaStream ? media.srcObject : null;
    audioTools ??= createTools();
    if (audioTools) {
        try {
            addMediaSource(audioTools, media);
        } catch (error) {
            ipcRenderer.sendToHost('gallery-error', {
                boxId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    applyMute();
    startLevelLoop();
}

function watchMedia(media: HTMLMediaElement): void {
    watchedMedia = media;
    switchHealthMedia = startMediaHealthLoop(media);

    if (isScreenShare) {
        window.addEventListener('live-gallery-media-ready', connectScreenShareAudioFromPage);
        return;
    }

    connectMedia(media);
    window.addEventListener('live-gallery-media-ready', () => {
        if (watchedMedia) {
            connectMedia(watchedMedia);
        }
    });
    window.setInterval(() => {
        if (
            watchedMedia &&
            (!watchedMedia.isConnected || performance.now() - lastMediaScanAt >= MEDIA_SCAN_MS)
        ) {
            recheckMedia();
        }
    }, MEDIA_RECHECK_MS);
    // Media events do not bubble, but a capturing listener still sees them in the page (not
    // inside shadow trees; the periodic search covers those). The element that fired is
    // checked on its own, with no search.
    const onMediaEvent = (event: Event): void => {
        if (event.target instanceof HTMLMediaElement) {
            recheckMedia([event.target]);
        }
    };
    document.addEventListener('playing', onMediaEvent, true);
    document.addEventListener('volumechange', onMediaEvent, true);
}

let lastMediaScanAt = 0;

// Keeps the box on the page's current media:
// - Any element in the page that is making sound is added to the meter.
// - Some players (JW Player, for one) rebuild themselves and put a new <video> in the page.
//   The old element is then dead, so the health checks built on it would go quiet for good.
// - If the watched element is paused while another one plays sound, the health checks and
//   the "playing" status move to that one.
// Without `candidates` it searches the whole page; events pass the one element they saw.
function recheckMedia(candidates?: HTMLMediaElement[]): void {
    const watched = watchedMedia;
    if (!watched) {
        return;
    }

    if (!candidates) {
        candidates = findMediaElements();
        lastMediaScanAt = performance.now();
    }
    if (audioTools) {
        dropRemovedMedia(audioTools);
        routeAudibleMedia(audioTools, candidates);
    }

    if (watched.isConnected && isPlaying(watched)) {
        return;
    }

    const next = pickMedia(candidates);
    if (!next || next === watched || (watched.isConnected && !isAudiblyPlaying(next))) {
        return;
    }

    watchedMedia = next;
    switchHealthMedia(next);
    connectMedia(next);
}

function sendVideoHealth(kind: VideoHealthAlert, active: boolean): void {
    ipcRenderer.sendToHost('gallery-health', {
        boxId,
        kind,
        active,
    });
}

// Returns a function that moves the checks onto a replacement element (see
// followReplacedMedia), starting its playback history afresh.
function startMediaHealthLoop(initialMedia: HTMLMediaElement): (next: HTMLMediaElement) => void {
    if (mediaHealthStarted) {
        return () => {};
    }

    mediaHealthStarted = true;
    let media = initialMedia;
    let hasStarted = false;
    let bufferingSince = 0;
    let lastTime = media.currentTime;
    let lastTimeChangedAt = performance.now();
    let bufferingActive = false;
    let wasBuffering = false;
    let repeatedBufferingActive = false;
    let bufferingEvents: number[] = [];
    let frozenActive = false;
    let playbackReported: boolean | null = null;

    const markStarted = (): void => {
        hasStarted = true;
        lastTime = media.currentTime;
        lastTimeChangedAt = performance.now();
    };

    // Events from an element that was replaced are ignored.
    const listen = (element: HTMLMediaElement): void => {
        element.addEventListener('playing', () => {
            if (element === media) {
                markStarted();
            }
        });
        element.addEventListener('timeupdate', () => {
            if (element === media && media.currentTime !== lastTime) {
                hasStarted = true;
                lastTime = media.currentTime;
                lastTimeChangedAt = performance.now();
            }
        });
    };
    listen(media);

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

        const playing = expectedPlaying && frozenForMs < PLAYBACK_STALE_MS;
        if (playing !== playbackReported) {
            playbackReported = playing;
            ipcRenderer.sendToHost('gallery-playback', { boxId, playing });
        }
    }, VIDEO_HEALTH_INTERVAL_MS);

    return (next) => {
        if (next === media) {
            return;
        }

        media = next;
        listen(next);
        hasStarted = false;
        lastTime = next.currentTime;
        lastTimeChangedAt = performance.now();
        bufferingSince = 0;
        wasBuffering = false;
    };
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
        window.dispatchEvent(new CustomEvent('live-gallery-reset-screen-share'));
    }
});

// Runs in the page's own world, as text injected before the page's scripts (this preload
// cannot reach the page's AudioContexts). Whatever the page connects to a context's
// destination goes through a tap first: a meter, then a gain that this world sets for mute
// and mono. The tap reports its levels back as events. Everything it uses is inside it or
// passed in, since it is not compiled with the rest of this file.
function installWebAudioTap(
    options: WebAudioTapOptions,
    peakDb: (data: Float32Array<ArrayBuffer>) => number,
    phaseOf: (
        left: Float32Array<ArrayBuffer>,
        right: Float32Array<ArrayBuffer>,
    ) => { correlation: number; monoLossDb: number } | null,
): void {
    type Tap = { input: GainNode; out: GainNode; analyserL: AnalyserNode; analyserR: AnalyserNode };

    const taps = new Map<BaseAudioContext, Tap>();
    const nativeConnect = AudioNode.prototype.connect;
    const nativeDisconnect = AudioNode.prototype.disconnect;
    const nativeSetInterval = window.setInterval.bind(window);
    const size = options.fftSize;
    const readLeft = new Float32Array(size);
    const readRight = new Float32Array(size);
    const sumLeft = new Float32Array(size);
    const sumRight = new Float32Array(size);
    let muted = true;
    let mono = options.mono;
    let reporting = false;
    let lastPhase: { correlation: number; monoLossDb: number } | null = null;
    let lastPhaseAt = 0;

    // The page's own connect is patched below; the tap's wiring uses the original.
    const link = (from: AudioNode, to: AudioNode, output?: number): void => {
        Reflect.apply(nativeConnect, from, output === undefined ? [to] : [to, output]);
    };

    const applyOutput = (tap: Tap): void => {
        tap.out.channelCountMode = mono ? 'explicit' : 'max';
        tap.out.channelCount = mono ? 1 : 2;
        tap.out.gain.value = muted ? 0 : 1;
    };

    const report = (): void => {
        sumLeft.fill(0);
        sumRight.fill(0);
        let active = 0;
        for (const [context, tap] of taps) {
            if (context.state === 'closed') {
                taps.delete(context);
                continue;
            }
            tap.analyserL.getFloatTimeDomainData(readLeft);
            tap.analyserR.getFloatTimeDomainData(readRight);
            for (let index = 0; index < size; index += 1) {
                sumLeft[index] += readLeft[index] ?? 0;
                sumRight[index] += readRight[index] ?? 0;
            }
            active += 1;
        }
        if (active === 0) {
            return;
        }

        const now = performance.now();
        if (now - lastPhaseAt >= options.phaseIntervalMs) {
            lastPhaseAt = now;
            lastPhase = phaseOf(sumLeft, sumRight);
        }
        window.dispatchEvent(
            new CustomEvent(options.levelEvent, {
                detail: {
                    left: peakDb(sumLeft),
                    right: peakDb(sumRight),
                    correlation: lastPhase?.correlation ?? null,
                    monoLossDb: lastPhase?.monoLossDb ?? null,
                },
            }),
        );
    };

    const tapFor = (destination: AudioDestinationNode): Tap | null => {
        const context = destination.context;
        if (context instanceof OfflineAudioContext) {
            return null;
        }

        const existing = taps.get(context);
        if (existing) {
            return existing;
        }

        try {
            // Always two channels into the meter, so a mono page does not read as one
            // channel missing.
            const input = context.createGain();
            input.channelCount = 2;
            input.channelCountMode = 'explicit';
            input.channelInterpretation = 'speakers';
            const out = context.createGain();
            const splitter = context.createChannelSplitter(2);
            const analyserL = context.createAnalyser();
            const analyserR = context.createAnalyser();
            analyserL.fftSize = size;
            analyserR.fftSize = size;
            link(input, out);
            link(out, destination);
            link(input, splitter);
            link(splitter, analyserL, 0);
            link(splitter, analyserR, 1);

            const tap = { input, out, analyserL, analyserR };
            applyOutput(tap);
            taps.set(context, tap);
            if (!reporting) {
                reporting = true;
                nativeSetInterval(report, options.intervalMs);
            }
            return tap;
        } catch {
            return null;
        }
    };

    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
        const [target, ...rest] = args;
        if (target instanceof AudioDestinationNode) {
            const tap = tapFor(target);
            if (tap) {
                Reflect.apply(nativeConnect, this, [tap.input, ...rest]);
                return target;
            }
        }
        return Reflect.apply(nativeConnect, this, args);
    } as typeof AudioNode.prototype.connect;

    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
        const [target, ...rest] = args;
        if (target instanceof AudioDestinationNode) {
            const tap = taps.get(target.context);
            if (tap) {
                return Reflect.apply(nativeDisconnect, this, [tap.input, ...rest]);
            }
        }
        return Reflect.apply(nativeDisconnect, this, args);
    } as typeof AudioNode.prototype.disconnect;

    window.addEventListener(options.controlEvent, (event) => {
        const detail = (event as CustomEvent<{ muted?: boolean; mono?: boolean }>).detail;
        muted = detail?.muted !== false;
        mono = detail?.mono === true;
        taps.forEach(applyOutput);
    });
}

function injectWebAudioTap(): void {
    const options: WebAudioTapOptions = {
        mono: monoOutput,
        fftSize: LEVEL_FFT_SIZE,
        intervalMs: LEVEL_INTERVAL_MS,
        phaseIntervalMs: PHASE_METRICS_INTERVAL_MS,
        levelEvent: WEB_AUDIO_LEVEL_EVENT,
        controlEvent: WEB_AUDIO_CONTROL_EVENT,
    };
    const source = `(() => {
        const PHASE_MIN_SIGNAL_RMS = ${PHASE_MIN_SIGNAL_RMS};
        ${calculatePeakDb.toString()}
        ${calculatePhaseMetrics.toString()}
        ;(${installWebAudioTap.toString()})(
            ${JSON.stringify(options)}, calculatePeakDb, calculatePhaseMetrics);
    })()`;
    webFrame.executeJavaScript(source).catch(() => {});

    window.addEventListener(WEB_AUDIO_LEVEL_EVENT, (event) => {
        const detail = (
            event as CustomEvent<{
                left: number;
                right: number;
                correlation: number | null;
                monoLossDb: number | null;
            }>
        ).detail;
        if (typeof detail?.left !== 'number' || typeof detail.right !== 'number') {
            return;
        }

        webAudioLevels = {
            left: detail.left,
            right: detail.right,
            phase:
                typeof detail.correlation === 'number' && typeof detail.monoLossDb === 'number'
                    ? { correlation: detail.correlation, monoLossDb: detail.monoLossDb }
                    : null,
            at: performance.now(),
        };
        startLevelLoop();
    });
}

if (!isScreenShare) {
    injectWebAudioTap();
}

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
