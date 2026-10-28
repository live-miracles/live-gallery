import {
    BoxType,
    GalleryBox,
    GallerySettings,
    deserializeBoxes,
    extractYouTubeId,
    getPlayerUrl,
    getSourceUrl,
    makeBox,
} from './utils.js';
import {
    audioClippingDb,
    createAlertController,
    type HealthPayload,
    type LevelPayload,
} from './alerts.js';
import { icon } from './icons.js';
import { createPresetController } from './presets.js';

const DOCS_URL = 'https://live-miracles.github.io/projects/live-gallery/docs/';

document.getElementById('add-box')!.innerHTML = icon('plus');

type ScreenShareValue = {
    micDeviceId: string;
    sourceId: string;
    sourceName: string;
    displayId: string;
};

type BoxElements = {
    root: HTMLElement;
    title: HTMLElement;
    number: HTMLElement;
    form: HTMLFormElement;
    viewport: HTMLElement;
    emptyState: HTMLElement;
    webview: Electron.WebviewTag;
    canvas: HTMLCanvasElement;
    muteButton: HTMLButtonElement;
    alertToggleButton: HTMLButtonElement;
    alertOverlay: HTMLElement;
    webviewReady: boolean;
    pendingCommands: Record<string, unknown>[];
};

type DebugWindow = Window & {
    liveGalleryDebug?: {
        audioLevels?: Record<string, LevelPayload & { receivedAt: number }>;
    };
};

const boxes: GalleryBox[] = [];
const elements = new Map<string, BoxElements>();
let mics: MediaDeviceInfo[] = [];
let rotationTimer = 0;
let clipboardToastTimer = 0;
let draggedId = '';
let micsPromise: Promise<void> | null = null;
let alertVolumeCloseTimer = 0;
let alertVolumeReturningFocus = false;
const meterClipHoldUntil = new Map<string, { left: number; right: number }>();
type MeterState = {
    canvas: HTMLCanvasElement;
    latest: { left: number; right: number };
    shown: { left: number; right: number };
    dirty: boolean;
};
const meterStates = new Map<string, MeterState>();
let meterFrame = 0;
let lastMeterFrameAt = 0;
const meterFloorDb = -91;
// Meters jump up instantly and fall back at this rate, like a broadcast peak meter.
const meterReleaseDbPerSecond = 20;
// One shared redraw loop for all boxes, capped at ~30 fps.
const meterFrameMs = 33;

const gallery = mustGet<HTMLElement>('gallery');
const muteRotationInput = mustGet<HTMLInputElement>('mute-rotation');
const rotateMenuButton = mustGet<HTMLButtonElement>('rotate-menu-button');
const rotationBoxesInput = mustGet<HTMLInputElement>('rotation-boxes');
const rotationTimeInput = mustGet<HTMLInputElement>('rotation-time');
const autoLiveInput = mustGet<HTMLInputElement>('auto-live');
const maxVolumeButton = mustGet<HTMLButtonElement>('max-volume');
const alertSoundButton = mustGet<HTMLButtonElement>('alert-sound');
const alertVolumeInput = mustGet<HTMLInputElement>('alert-volume');
const alertVolumeValue = mustGet<HTMLElement>('alert-volume-value');
const alertVolumePopover = mustGet<HTMLElement>('alert-volume-popover');
const alertSoundControl = mustGet<HTMLElement>('alert-sound-control');
const audioOutputButton = mustGet<HTMLButtonElement>('audio-output');
const alertVideoBufferingInput = mustGet<HTMLInputElement>('alert-video-buffering');
const alertVideoRepeatedBufferingInput = mustGet<HTMLInputElement>(
    'alert-video-repeated-buffering',
);
const alertVideoFrozenInput = mustGet<HTMLInputElement>('alert-video-frozen');
const alertAudioSilentInput = mustGet<HTMLInputElement>('alert-audio-silent');
const alertAudioDropoutsInput = mustGet<HTMLInputElement>('alert-audio-dropouts');
const alertAudioClippingInput = mustGet<HTMLInputElement>('alert-audio-clipping');
const alertAudioChannelMissingInput = mustGet<HTMLInputElement>('alert-audio-channel-missing');
const alertAudioImbalanceInput = mustGet<HTMLInputElement>('alert-audio-imbalance');
const alertAudioPhaseMismatchInput = mustGet<HTMLInputElement>('alert-audio-phase-mismatch');
const presetMenu = mustGet<HTMLDetailsElement>('preset-menu');
const savedPresetList = mustGet<HTMLElement>('saved-preset-list');
const newPresetButton = mustGet<HTMLButtonElement>('new-preset');
const exportPresetButton = mustGet<HTMLButtonElement>('export-preset');
const copyPresetButton = mustGet<HTMLButtonElement>('copy-preset');
const importPresetButton = mustGet<HTMLButtonElement>('import-preset');
const importPresetClipboardButton = mustGet<HTMLButtonElement>('import-preset-clipboard');
const savePresetButton = mustGet<HTMLButtonElement>('save-preset');
const alertsButton = mustGet<HTMLButtonElement>('alerts-button');
const alertsCount = mustGet<HTMLElement>('alerts-count');
const fullscreenButton = mustGet<HTMLButtonElement>('toggle-fullscreen');
const refreshPageButton = mustGet<HTMLButtonElement>('refresh-page');
const zoomOutButton = mustGet<HTMLButtonElement>('zoom-out');
const zoomInButton = mustGet<HTMLButtonElement>('zoom-in');
const zoomStatusButton = mustGet<HTMLButtonElement>('zoom-status');
const updateToast = mustGet<HTMLElement>('update-toast');
const updateText = mustGet<HTMLElement>('update-text');
const updateProgress = mustGet<HTMLProgressElement>('update-progress');
const updateDismissButton = mustGet<HTMLButtonElement>('update-dismiss-btn');
const updateDownloadButton = mustGet<HTMLButtonElement>('update-download-btn');
const updateRestartButton = mustGet<HTMLButtonElement>('update-restart-btn');
const clipboardToast = mustGet<HTMLElement>('clipboard-toast');
const clipboardToastIcon = mustGet<HTMLElement>('clipboard-toast-icon');
const clipboardToastText = mustGet<HTMLElement>('clipboard-toast-text');
const presetNameDialog = mustGet<HTMLDialogElement>('preset-name-dialog');
const presetNameTitle = mustGet<HTMLElement>('preset-name-title');
const presetNameInput = mustGet<HTMLInputElement>('preset-name-input');
const alertsDialog = mustGet<HTMLDialogElement>('alerts-dialog');
const alertsList = mustGet<HTMLElement>('alerts-list');
const settingsDialog = mustGet<HTMLDialogElement>('settings-dialog');
const settingsForm = mustGet<HTMLFormElement>('settings-form');
const jwServerHostInput = mustGet<HTMLInputElement>('jw-server-host');
const uiZoomInput = mustGet<HTMLSelectElement>('ui-zoom');

const settings: GallerySettings = {
    audioLevels: true,
    monoOutput: false,
    boxZoom: 100,
    uiZoom: 100,
    muteRotation: false,
    rotationBoxes: '',
    rotationTime: 5,
    autoLive: true,
    jwServerHost: 'https://your.website.com/Player/Index/',
    alertSound: true,
    alertVolume: 100,
    alertVideoBuffering: true,
    alertVideoRepeatedBuffering: true,
    alertVideoFrozen: true,
    alertAudioSilent: true,
    alertAudioDropouts: true,
    alertAudioClipping: true,
    alertAudioChannelMissing: true,
    alertAudioImbalance: true,
    alertAudioPhaseMismatch: true,
};

const minBoxZoomPercent = 50;
const uiZoomOptions = [75, 90, 100, 110, 125, 150, 175, 200];
const maxBoxZoomPercent = 1000;
// Zoom steps: 5% below 100%, then a tenth of each hundred (10% from 100%, 20% from
// 200%, 30% from 300%, ...), always landing exactly on every hundred.
const boxZoomStops = (() => {
    const stops: number[] = [];
    for (let value = minBoxZoomPercent; value < 100; value += 5) {
        stops.push(value);
    }
    for (let band = 100; band < maxBoxZoomPercent; band += 100) {
        for (let value = band; value < band + 100; value += band / 10) {
            stops.push(value);
        }
    }
    stops.push(maxBoxZoomPercent);
    return stops;
})();

const alertController = createAlertController({
    settings,
    boxes,
    elements,
    alertsButton,
    alertsCount,
    alertsList,
    getBoxTitle,
});

const presetController = createPresetController({
    boxes,
    presetMenu,
    savedPresetList,
    presetNameDialog,
    presetNameTitle,
    presetNameInput,
    newPresetButton,
    exportPresetButton,
    copyPresetButton,
    importPresetButton,
    importPresetClipboardButton,
    savePresetButton,
    render,
    showToast,
});

function mustGet<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing #${id}`);
    }
    return element as T;
}

function clampBoxZoom(percent: number): number {
    if (!Number.isFinite(percent)) {
        return 100;
    }
    return Math.max(minBoxZoomPercent, Math.min(maxBoxZoomPercent, Math.round(percent)));
}

function applyBoxZoom(): void {
    document.documentElement.style.setProperty('--box-scale', String(settings.boxZoom / 100));
    zoomStatusButton.textContent = `${settings.boxZoom}%`;
    zoomOutButton.disabled = settings.boxZoom <= minBoxZoomPercent;
    zoomInButton.disabled = settings.boxZoom >= maxBoxZoomPercent;
}

function applyUiZoom(): void {
    window.liveGallery.setUiZoom(settings.uiZoom).catch((error: unknown) => {
        console.error('Could not set interface size:', error);
    });
}

function setBoxZoom(percent: number): void {
    const nextZoom = clampBoxZoom(percent);
    if (nextZoom === settings.boxZoom) {
        return;
    }

    settings.boxZoom = nextZoom;
    applyBoxZoom();
    saveState();
}

function getBoxTitle(box: GalleryBox): string {
    return box.name ? `${box.type}: ${box.name}` : box.type;
}

function initZoomControls(): void {
    window.liveGallery.onBoxZoomStep((direction) => {
        if (direction === 0) {
            setBoxZoom(100);
        } else {
            changeBoxZoomStep(direction);
        }
    });

    zoomOutButton.addEventListener('click', () => changeBoxZoomStep(-1));
    zoomInButton.addEventListener('click', () => changeBoxZoomStep(1));
    zoomStatusButton.addEventListener('click', () => setBoxZoom(100));
}

function changeBoxZoomStep(direction: -1 | 1): void {
    const current = settings.boxZoom;
    const nextZoom =
        direction > 0
            ? boxZoomStops.find((stop) => stop > current)
            : boxZoomStops.filter((stop) => stop < current).pop();
    if (nextZoom !== undefined) {
        setBoxZoom(nextZoom);
    }
}

function initWindowControls(): void {
    fullscreenButton.addEventListener('click', () => {
        window.liveGallery.toggleFullscreen().catch(console.error);
    });
    refreshPageButton.addEventListener('click', () => {
        window.liveGallery.reload().catch(console.error);
    });
}

function initPresetMenuControls(): void {
    document.addEventListener('pointerdown', (event) => {
        if (!presetMenu.open || !(event.target instanceof Node)) {
            return;
        }

        if (!presetMenu.contains(event.target)) {
            presetMenu.open = false;
        }
    });

    document.addEventListener('focusin', (event) => {
        if (!presetMenu.open || !(event.target instanceof Node)) {
            return;
        }

        if (!presetMenu.contains(event.target)) {
            presetMenu.open = false;
        }
    });
}

function initUpdateControls(): void {
    window.liveGallery.onUpdateAvailable(() => {
        updateToast.classList.remove('hidden');
        updateText.textContent = 'Update available';
        updateProgress.classList.add('hidden');
        updateProgress.value = 0;
        updateDownloadButton.classList.remove('hidden');
        updateDismissButton.classList.remove('hidden');
        updateRestartButton.classList.add('hidden');
    });

    window.liveGallery.onUpdateProgress((progress) => {
        updateToast.classList.remove('hidden');
        updateProgress.classList.remove('hidden');
        updateProgress.value = progress;
        updateText.textContent = `Downloading ${Math.round(progress)}%`;
        updateDownloadButton.classList.add('hidden');
        updateDismissButton.classList.add('hidden');
        updateRestartButton.classList.add('hidden');
    });

    window.liveGallery.onUpdateReady(() => {
        updateToast.classList.remove('hidden');
        updateText.textContent = 'Update ready';
        updateProgress.classList.add('hidden');
        updateDownloadButton.classList.add('hidden');
        updateDismissButton.classList.remove('hidden');
        updateRestartButton.classList.remove('hidden');
    });

    updateDownloadButton.addEventListener('click', () => {
        updateText.textContent = 'Downloading...';
        updateProgress.value = 0;
        updateProgress.classList.remove('hidden');
        updateDownloadButton.classList.add('hidden');
        updateDismissButton.classList.add('hidden');
        window.liveGallery.downloadUpdate();
    });
    updateDismissButton.addEventListener('click', () => updateToast.classList.add('hidden'));
    updateRestartButton.addEventListener('click', () => window.liveGallery.installUpdate());
}

function syncSettingsFromControls(): void {
    settings.muteRotation = muteRotationInput.checked;
    settings.rotationBoxes = rotationBoxesInput.value;
    settings.rotationTime = Math.max(1, Number(rotationTimeInput.value) || 1);
    settings.autoLive = autoLiveInput.checked;
    settings.jwServerHost = jwServerHostInput.value.trim();
    settings.uiZoom = Number(uiZoomInput.value) || 100;
    settings.alertVideoBuffering = alertVideoBufferingInput.checked;
    settings.alertVideoRepeatedBuffering = alertVideoRepeatedBufferingInput.checked;
    settings.alertVideoFrozen = alertVideoFrozenInput.checked;
    settings.alertAudioSilent = alertAudioSilentInput.checked;
    settings.alertAudioDropouts = alertAudioDropoutsInput.checked;
    settings.alertAudioClipping = alertAudioClippingInput.checked;
    settings.alertAudioChannelMissing = alertAudioChannelMissingInput.checked;
    settings.alertAudioImbalance = alertAudioImbalanceInput.checked;
    settings.alertAudioPhaseMismatch = alertAudioPhaseMismatchInput.checked;
}

function syncControlsFromSettings(): void {
    muteRotationInput.checked = settings.muteRotation;
    rotationBoxesInput.value = settings.rotationBoxes;
    rotationTimeInput.value = String(settings.rotationTime);
    autoLiveInput.checked = settings.autoLive;
    jwServerHostInput.value = settings.jwServerHost;
    uiZoomInput.value = String(settings.uiZoom);
    syncAlertSoundControl();
    syncAudioOutputButton();
    alertVideoBufferingInput.checked = settings.alertVideoBuffering;
    alertVideoRepeatedBufferingInput.checked = settings.alertVideoRepeatedBuffering;
    alertVideoFrozenInput.checked = settings.alertVideoFrozen;
    alertAudioSilentInput.checked = settings.alertAudioSilent;
    alertAudioDropoutsInput.checked = settings.alertAudioDropouts;
    alertAudioClippingInput.checked = settings.alertAudioClipping;
    alertAudioChannelMissingInput.checked = settings.alertAudioChannelMissing;
    alertAudioImbalanceInput.checked = settings.alertAudioImbalance;
    alertAudioPhaseMismatchInput.checked = settings.alertAudioPhaseMismatch;
    syncRotationControlsVisibility();
    updateRotationBoxesValidity();
}

function syncRotationControlsVisibility(): void {
    const isRotating = muteRotationInput.checked;
    rotationBoxesInput.disabled = !isRotating;
    rotationTimeInput.disabled = !isRotating;
    rotateMenuButton.classList.toggle('is-on', isRotating);
}

function sanitizeRotationBoxesInput(): void {
    rotationBoxesInput.value = rotationBoxesInput.value.replace(/[^\d\s-]/g, ' ');
    updateRotationBoxesValidity();
}

function updateRotationBoxesValidity(): boolean {
    const error = getRotationBoxesSyntaxError(rotationBoxesInput.value);
    rotationBoxesInput.setAttribute('aria-invalid', String(Boolean(error)));
    rotationBoxesInput.title = error ?? '';
    return !error;
}

function getRotationBoxesSyntaxError(value: string): string | null {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        const singleNumber = token.match(/^\d+$/);
        if (singleNumber) {
            continue;
        }

        const range = token.match(/^(\d+)-(\d+)$/);
        if (!range) {
            return 'Use numbers or ranges like 2 4 9-11. Dashes need numbers on both sides.';
        }

        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end <= start) {
            return 'Range end must be greater than range start.';
        }
    }

    return null;
}

function saveState(): void {
    localStorage.setItem('live-gallery-boxes', JSON.stringify(boxes));
    localStorage.setItem('live-gallery-settings', JSON.stringify(settings));
}

function loadState(): void {
    const params = new URLSearchParams(window.location.search);
    const sharedBoxes = deserializeBoxes(params.get('boxes'));
    const storedBoxes = JSON.parse(
        localStorage.getItem('live-gallery-boxes') ?? '[]',
    ) as GalleryBox[];
    const storedSettings = JSON.parse(
        localStorage.getItem('live-gallery-settings') ?? '{}',
    ) as Partial<GallerySettings>;

    Object.assign(settings, storedSettings);
    settings.audioLevels = true;
    settings.jwServerHost = String(settings.jwServerHost ?? '');
    settings.monoOutput = storedSettings.monoOutput ?? false;
    settings.boxZoom = clampBoxZoom(storedSettings.boxZoom ?? 100);
    settings.uiZoom = uiZoomOptions.includes(storedSettings.uiZoom ?? 100)
        ? (storedSettings.uiZoom ?? 100)
        : 100;
    settings.alertSound = storedSettings.alertSound ?? true;
    settings.alertVolume = clampAlertVolume(storedSettings.alertVolume ?? 100);
    settings.alertVideoBuffering = storedSettings.alertVideoBuffering ?? true;
    settings.alertVideoRepeatedBuffering = storedSettings.alertVideoRepeatedBuffering ?? true;
    settings.alertVideoFrozen = storedSettings.alertVideoFrozen ?? true;
    settings.alertAudioSilent = storedSettings.alertAudioSilent ?? true;
    settings.alertAudioDropouts = storedSettings.alertAudioDropouts ?? true;
    settings.alertAudioClipping = storedSettings.alertAudioClipping ?? true;
    settings.alertAudioChannelMissing = storedSettings.alertAudioChannelMissing ?? true;
    settings.alertAudioImbalance = storedSettings.alertAudioImbalance ?? true;
    settings.alertAudioPhaseMismatch = storedSettings.alertAudioPhaseMismatch ?? true;
    syncControlsFromSettings();
    boxes.splice(0, boxes.length, ...(sharedBoxes.length > 0 ? sharedBoxes : storedBoxes));

    if (boxes.length === 0) {
        boxes.push(makeBox());
    }
}

function clampAlertVolume(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }

    return Math.max(0, Math.min(500, Math.round(value)));
}

// Works like a video player's volume control: the bell mutes and unmutes, the slider
// sets the level, and sliding to 0 mutes. Muting keeps the last volume.
function syncAlertSoundControl(): void {
    const audible = settings.alertSound && settings.alertVolume > 0;
    const volume = settings.alertSound ? settings.alertVolume : 0;
    alertSoundButton.innerHTML = icon(audible ? 'bell' : 'bell-off');
    alertSoundButton.classList.toggle('btn-muted', audible);
    alertSoundButton.classList.toggle('is-alert', !audible);
    const label = audible
        ? `Alert beeps at ${volume}% (click to mute)`
        : 'Alert beeps muted (click to unmute)';
    alertSoundButton.title = label;
    alertSoundButton.setAttribute('aria-label', label);
    alertVolumeInput.value = String(volume);
    alertVolumeValue.textContent = `${volume}%`;
}

function openAlertVolume(): void {
    window.clearTimeout(alertVolumeCloseTimer);
    if (!alertVolumePopover.matches(':popover-open')) {
        alertVolumePopover.showPopover();
    }
}

function closeAlertVolume(): void {
    window.clearTimeout(alertVolumeCloseTimer);
    if (alertVolumePopover.matches(':popover-open')) {
        alertVolumePopover.hidePopover();
    }
}

// The short delay lets the pointer cross the gap from the bell to the popover.
function closeAlertVolumeSoon(): void {
    window.clearTimeout(alertVolumeCloseTimer);
    alertVolumeCloseTimer = window.setTimeout(() => {
        if (!alertSoundControl.querySelector(':focus-visible')) {
            closeAlertVolume();
        }
    }, 250);
}

function toggleAlertSound(): void {
    const audible = settings.alertSound && settings.alertVolume > 0;
    settings.alertSound = !audible;
    if (settings.alertSound && settings.alertVolume === 0) {
        settings.alertVolume = 100;
    }
    syncAlertSoundControl();
    saveState();
    alertController.render();
}

function setAlertVolumeFromSlider(): void {
    settings.alertVolume = clampAlertVolume(Number(alertVolumeInput.value));
    settings.alertSound = settings.alertVolume > 0;
    syncAlertSoundControl();
}

function syncAudioOutputButton(): void {
    const mode = settings.monoOutput ? 'mono' : 'stereo';
    audioOutputButton.innerHTML = icon(settings.monoOutput ? 'speaker-mono' : 'speaker-stereo');
    audioOutputButton.classList.toggle('is-on', settings.monoOutput);
    const label = `Audio output: ${mode} (click for ${settings.monoOutput ? 'stereo' : 'mono'})`;
    audioOutputButton.title = label;
    audioOutputButton.setAttribute('aria-label', label);
}

function toggleMonoOutput(): void {
    settings.monoOutput = !settings.monoOutput;
    syncAudioOutputButton();
    boxes.forEach(syncAudioCommands);
    saveState();
}

function render(): void {
    gallery.replaceChildren();
    elements.clear();
    meterStates.clear();
    meterClipHoldUntil.clear();
    boxes.forEach((box, index) => renderBox(box, index));
    alertController.resetAll();
    saveState();
    restartRotation();
}

function addBox(): void {
    const box = makeBox();
    boxes.push(box);
    renderBox(box, boxes.length - 1, true);
    saveState();
    restartRotation();
}

function renderBox(box: GalleryBox, index: number, isEditing = false): void {
    const root = document.createElement('article');
    root.className =
        'bg-surface relative m-1 h-fit w-[calc(279px*var(--box-scale))] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[10px] border border-white/10 shadow-lg shadow-black/40';
    root.innerHTML = `
        <div class="box-header group bg-surface border-hairline relative flex h-[22px] w-full items-center overflow-hidden border-b">
          <button class="drag-handle btn box-tool-btn relative z-20 cursor-grab" title="Drag to reorder this box" aria-label="Drag to reorder this box">${icon('grip')}</button>
          <span class="box-number text-label-2 absolute top-0 left-6.5 z-20 h-[22px] cursor-grab text-xs leading-[22px] font-medium tabular-nums select-none" title="Drag to reorder this box"></span>
          <strong class="box-title bg-surface pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8 text-center text-xs font-semibold whitespace-nowrap group-hover:hidden group-focus-within:hidden"></strong>
          <button class="alert-visibility btn box-tool-btn box-tool-btn-first" title="Hide alerts for this box" aria-label="Hide alerts for this box">${icon('eye')}</button>
          <button class="mute btn box-tool-btn" title="Mute this box" aria-label="Mute this box"></button>
          <button class="solo btn box-tool-btn" title="Solo this box and mute the others" aria-label="Solo this box and mute the others">${icon('headphones')}</button>
          <button class="reload btn box-tool-btn" title="Reload this box" aria-label="Reload this box">${icon('refresh')}</button>
          <button class="copy-url btn box-tool-btn" title="Copy this box's URL" aria-label="Copy this box's URL">${icon('copy')}</button>
          <button class="edit btn box-tool-btn" title="Edit this box" aria-label="Edit this box">${icon('pencil')}</button>
          <button class="remove btn btn-danger box-tool-btn" title="Remove this box" aria-label="Remove this box">${icon('trash')}</button>
          <button class="expand btn box-tool-btn" title="Expand this box" aria-label="Expand this box">${icon('maximize')}</button>
        </div>
        <form class="box-form material absolute top-7 left-1/2 z-30 hidden w-[min(15rem,calc(100vw-2rem))] -translate-x-1/2 grid-cols-1 gap-1.5 rounded-[10px] p-2">
          <input name="name" class="field field-sm" type="text" placeholder="Name" />
          <select name="type" class="field field-sm">
            <option value="YT">YouTube</option>
            <option value="JW">JW Player</option>
            <option value="VC">VdoCipher</option>
            <option value="SS">Screen Share</option>
            <option value="CU">Custom URL</option>
            <option value="LF">Local File</option>
          </select>
          <div class="value-slot"></div>
          <div class="mt-1 flex justify-center gap-2">
            <button type="button" class="cancel btn btn-sm btn-gray min-w-16">Cancel</button>
            <button type="submit" class="btn btn-sm btn-primary min-w-16">Save</button>
          </div>
        </form>
        <div class="viewport relative bg-black overflow-hidden">
          <div class="player-frame relative mr-2.5 aspect-video overflow-hidden">
            <webview class="player absolute bg-black top-0 left-0 h-[160%] w-[160%] origin-top-left scale-[0.625]" style="color-scheme: light" allowpopups></webview>
          </div>
          <canvas class="meter pointer-events-none absolute top-0 right-0 h-full w-2.5 bg-black/30" width="10" height="180"></canvas>
          <div class="alert-overlay pointer-events-none absolute inset-0 z-20 hidden place-items-center p-3"></div>
          <div class="empty-state text-label-3 pointer-events-none absolute inset-0 grid place-items-center p-5 text-center text-xs">Configure this box to load a live source.</div>
        </div>`;

    const title = root.querySelector<HTMLElement>('.box-title')!;
    const number = root.querySelector<HTMLElement>('.box-number')!;
    const form = root.querySelector<HTMLFormElement>('.box-form')!;
    const dragHandle = root.querySelector<HTMLButtonElement>('.drag-handle')!;
    const viewport = root.querySelector<HTMLElement>('.viewport')!;
    const emptyState = root.querySelector<HTMLElement>('.empty-state')!;
    const webview = root.querySelector<Electron.WebviewTag>('webview')!;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
    const muteButton = root.querySelector<HTMLButtonElement>('.mute')!;
    const expandButton = root.querySelector<HTMLButtonElement>('.expand')!;
    const alertToggleButton = root.querySelector<HTMLButtonElement>('.alert-visibility')!;
    const alertOverlay = root.querySelector<HTMLElement>('.alert-overlay')!;

    root.dataset.id = box.id;
    [dragHandle, number].forEach((dragTarget) => {
        dragTarget.draggable = true;
    });
    number.textContent = String(index + 1);
    syncBoxControls(
        {
            root,
            title,
            number,
            form,
            viewport,
            emptyState,
            webview,
            canvas,
            muteButton,
            alertToggleButton,
            alertOverlay,
            webviewReady: false,
            pendingCommands: [],
        },
        box,
        isEditing,
    );

    webview.setAttribute('preload', window.liveGallery.guestPreloadUrl);
    webview.setAttribute('useragent', navigator.userAgent.replace(/\sElectron\/\S+/g, ''));
    webview.setAttribute(
        'webpreferences',
        'contextIsolation=yes,nodeIntegration=no,webSecurity=no',
    );
    webview.addEventListener('ipc-message', (event) => {
        if (event.channel === 'gallery-level') {
            const payload = event.args[0] as LevelPayload;
            const debugWindow = window as DebugWindow;
            debugWindow.liveGalleryDebug ??= {};
            debugWindow.liveGalleryDebug.audioLevels ??= {};
            debugWindow.liveGalleryDebug.audioLevels[payload.boxId] = {
                ...payload,
                receivedAt: Date.now(),
            };
            updateMeter(canvas, payload);
            alertController.updateAudioHealth(payload);
        } else if (event.channel === 'gallery-health') {
            alertController.updateFromHealth(event.args[0] as HealthPayload);
        } else if (event.channel === 'gallery-error') {
            console.warn(`Box ${box.name || box.id} player error:`, event.args[0]);
        } else if (event.channel === 'gallery-screen-share-source') {
            rememberScreenShareSource(box, event.args[0] as Partial<DesktopSource>);
        } else if (event.channel === 'gallery-screen-share-ended') {
            alertController.clearBox(box.id);
            resetScreenShareSource(box);
        } else if (event.channel === 'gallery-open-screen-share-picker') {
            openScreenSharePicker(box.id).catch((error) => {
                console.error('Could not open screen share picker:', error);
                showToast('Could not load windows', 'error');
            });
        } else if (event.channel === 'gallery-escape') {
            closeExpandedBox();
        }
    });
    webview.addEventListener('did-fail-load', (event) => {
        console.warn(`Box ${box.name || box.id} failed to load:`, event.errorDescription);
    });
    webview.addEventListener('dom-ready', () => {
        const entry = elements.get(box.id);
        if (!entry) {
            return;
        }

        entry.webviewReady = true;
        flushPendingCommands(entry);
    });
    webview.addEventListener('did-finish-load', () => {
        sendCommand(box.id, { type: 'mute', muted: box.muted });
    });

    expandButton.addEventListener('click', () => {
        toggleExpanded(root);
        syncExpandButtonTitle(expandButton, root);
    });
    root.querySelector<HTMLButtonElement>('.edit')!.addEventListener('click', () => {
        setEditing(form, true);
    });
    root.querySelector<HTMLButtonElement>('.reload')!.addEventListener('click', () =>
        loadWebview(box, true),
    );
    root.querySelector<HTMLButtonElement>('.copy-url')!.addEventListener('click', () => {
        copyBoxUrl(box);
    });
    root.querySelector<HTMLButtonElement>('.remove')!.addEventListener('click', () =>
        removeBox(box.id),
    );
    root.querySelector<HTMLButtonElement>('.solo')!.addEventListener('click', () => {
        disableRotationAudio();
        soloBox(box.id);
    });
    alertToggleButton.addEventListener('click', () => alertController.toggleBoxAlerts(box.id));
    root.querySelector<HTMLButtonElement>('.cancel')!.addEventListener('click', () =>
        setEditing(form, false),
    );
    muteButton.addEventListener('click', () => toggleMute(box.id));
    (form.elements.namedItem('type') as HTMLSelectElement).addEventListener('change', () => {
        const type = (form.elements.namedItem('type') as HTMLSelectElement).value as BoxType;
        const currentValue = String(new FormData(form).get('value') ?? '');
        setValueField(
            form,
            type,
            type === 'SS'
                ? normalizeScreenShareFormValue('', currentValue)
                : isScreenShareValue(currentValue)
                  ? ''
                  : currentValue,
        );
        clearBoxValueError(form);
        if (type === 'SS' && mics.length === 0) {
            loadMics().then(() => {
                if ((form.elements.namedItem('type') as HTMLSelectElement).value === 'SS') {
                    setValueField(form, type, normalizeScreenShareFormValue('', currentValue));
                }
            });
        }
    });

    root.addEventListener('dragstart', (event) => {
        const dragSource = event.target instanceof HTMLElement ? event.target : null;
        if (!dragSource?.closest('.drag-handle, .box-number')) {
            event.preventDefault();
            return;
        }

        draggedId = box.id;
        root.classList.add('box-dragging');
        gallery.classList.add('gallery-dragging');
        event.dataTransfer?.setData('text/plain', box.id);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setDragImage(root, root.offsetWidth / 2, 10);
        }
    });
    root.addEventListener('dragend', () => {
        draggedId = '';
        root.classList.remove('box-dragging');
        gallery.classList.remove('gallery-dragging');
    });
    root.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
    });
    root.addEventListener('drop', (event) => {
        event.preventDefault();
        moveBox(draggedId, box.id);
    });

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const nextType = String(formData.get('type') ?? 'YT') as BoxType;
        const rawValue = String(formData.get('value') ?? '');
        if (requiresBoxValue(nextType) && !rawValue.trim()) {
            showBoxValueError(form);
            return;
        }

        clearBoxValueError(form);
        box.name = String(formData.get('name') ?? '');
        box.type = nextType;
        box.value =
            box.type === 'YT'
                ? extractYouTubeId(rawValue)
                : box.type === 'SS'
                  ? normalizeScreenShareFormValue(rawValue, box.value)
                  : rawValue;
        setEditing(form, false);
        syncBoxControls(
            {
                root,
                title,
                number,
                form,
                viewport,
                emptyState,
                webview,
                canvas,
                muteButton,
                alertToggleButton,
                alertOverlay,
                webviewReady: false,
                pendingCommands: [],
            },
            box,
            false,
        );
        loadWebview(box);
        saveState();
        restartRotation();
    });

    gallery.appendChild(root);
    elements.set(box.id, {
        root,
        title,
        number,
        form,
        viewport,
        emptyState,
        webview,
        canvas,
        muteButton,
        alertToggleButton,
        alertOverlay,
        webviewReady: false,
        pendingCommands: [],
    });
    loadWebview(box);
}

function syncBoxControls(entry: BoxElements, box: GalleryBox, isEditing: boolean): void {
    entry.title.textContent = getBoxTitle(box);
    entry.muteButton.innerHTML = icon(box.muted ? 'volume-x' : 'volume-2');
    syncMuteButtonTitle(entry.muteButton, box.muted);
    setUnmuted(entry.root, !box.muted);
    setEditing(entry.form, isEditing);

    (entry.form.elements.namedItem('name') as HTMLInputElement).value = box.name;
    (entry.form.elements.namedItem('type') as HTMLSelectElement).value = box.type;
    setValueField(entry.form, box.type, box.value);

    if (box.type === 'SS' && mics.length === 0) {
        loadMics().then(() => {
            if ((entry.form.elements.namedItem('type') as HTMLSelectElement).value === 'SS') {
                setValueField(entry.form, box.type, box.value);
            }
        });
    }
}

function setValueField(form: HTMLFormElement, type: BoxType, value: string): void {
    const screenShareValue = parseScreenShareValue(value);
    form.querySelector<HTMLElement>('.value-slot')!.innerHTML =
        type === 'SS'
            ? `<select name="value" class="field field-sm w-full">
                <option value="${escapeAttribute(serializeScreenShareValue({ ...screenShareValue, micDeviceId: '' }))}">None</option>
                ${mics
                    .map(
                        (mic) =>
                            `<option value="${escapeAttribute(
                                serializeScreenShareValue({
                                    ...screenShareValue,
                                    micDeviceId: mic.deviceId,
                                }),
                            )}" ${screenShareValue.micDeviceId === mic.deviceId ? 'selected' : ''}>${escapeHtml(mic.label)}</option>`,
                    )
                    .join('')}
              </select>`
            : type === 'LF'
              ? `<div class="flex w-full gap-1.5">
                  <input name="value" class="field field-sm min-w-0 flex-1" type="text" placeholder="Choose audio or video file" value="${escapeAttribute(value)}" readonly />
                  <button type="button" class="browse-local-file btn btn-sm btn-gray">Browse…</button>
                </div>`
              : `<input name="value" class="field field-sm w-full" type="text" placeholder="URL or ID" value="${escapeAttribute(value)}" />`;
    const control = form.elements.namedItem('value');
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
        control.addEventListener('input', () => clearBoxValueError(form));
    }
    const browseLocalFileButton = form.querySelector<HTMLButtonElement>('.browse-local-file');
    if (type === 'LF' && browseLocalFileButton && control instanceof HTMLInputElement) {
        browseLocalFileButton.addEventListener('click', () => {
            window.liveGallery
                .selectLocalMediaFile()
                .then((fileUrl) => {
                    if (!fileUrl) {
                        return;
                    }

                    control.value = fileUrl;
                    clearBoxValueError(form);
                })
                .catch((error) => {
                    console.error('Could not choose local file:', error);
                    showToast('Could not choose file', 'error');
                });
        });
    }
    if (type === 'YT' && control instanceof HTMLInputElement) {
        control.addEventListener('paste', (event) => {
            const pastedText = event.clipboardData?.getData('text');
            if (!pastedText) {
                return;
            }

            event.preventDefault();
            control.value = extractYouTubeId(pastedText);
            clearBoxValueError(form);
        });
    }
}

function requiresBoxValue(_type: BoxType): boolean {
    return false;
}

function showBoxValueError(form: HTMLFormElement): void {
    const control = form.elements.namedItem('value');
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
        return;
    }

    control.setAttribute('aria-invalid', 'true');
    control.title = 'URL or ID is required.';
    control.focus();
}

function clearBoxValueError(form: HTMLFormElement): void {
    const control = form.elements.namedItem('value');
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
        return;
    }

    control.removeAttribute('aria-invalid');
    control.title = '';
}

function parseScreenShareValue(value: string): ScreenShareValue {
    try {
        const parsed = JSON.parse(value) as Partial<ScreenShareValue>;
        return {
            micDeviceId: String(parsed.micDeviceId ?? ''),
            sourceId: String(parsed.sourceId ?? ''),
            sourceName: String(parsed.sourceName ?? ''),
            displayId: String(parsed.displayId ?? ''),
        };
    } catch {
        return {
            micDeviceId: '',
            sourceId: '',
            sourceName: '',
            displayId: '',
        };
    }
}

function isScreenShareValue(value: string): boolean {
    if (!value.trim()) {
        return false;
    }

    try {
        const parsed = JSON.parse(value) as Partial<ScreenShareValue>;
        return (
            typeof parsed === 'object' &&
            parsed !== null &&
            ('micDeviceId' in parsed ||
                'sourceId' in parsed ||
                'sourceName' in parsed ||
                'displayId' in parsed)
        );
    } catch {
        return false;
    }
}

function serializeScreenShareValue(value: ScreenShareValue): string {
    return JSON.stringify({
        micDeviceId: value.micDeviceId,
        sourceId: value.sourceId,
        sourceName: value.sourceName,
        displayId: value.displayId,
    });
}

function normalizeScreenShareFormValue(rawValue: string, previousValue: string): string {
    const value = parseScreenShareValue(rawValue);
    const previous = parseScreenShareValue(previousValue);
    return serializeScreenShareValue({
        micDeviceId: value.micDeviceId,
        sourceId: value.sourceId || previous.sourceId,
        sourceName: value.sourceName || previous.sourceName,
        displayId: value.displayId || previous.displayId,
    });
}

function rememberScreenShareSource(box: GalleryBox, source: Partial<DesktopSource>): void {
    if (box.type !== 'SS') {
        return;
    }

    const value = parseScreenShareValue(box.value);
    box.value = serializeScreenShareValue({
        ...value,
        sourceId: String(source.id ?? ''),
        sourceName: '',
        displayId: '',
    });
    saveState();

    const entry = elements.get(box.id);
    if (entry) {
        setValueField(entry.form, box.type, box.value);
    }
}

function resetScreenShareSource(box: GalleryBox): void {
    if (box.type !== 'SS') {
        return;
    }

    alertController.clearBox(box.id);
    const value = parseScreenShareValue(box.value);
    box.value = serializeScreenShareValue({
        ...value,
        sourceId: '',
        sourceName: '',
        displayId: '',
    });
    saveState();

    const entry = elements.get(box.id);
    if (entry) {
        setValueField(entry.form, box.type, box.value);
        sendCommand(box.id, { type: 'reset-screen-share' });
    }
}

async function openScreenSharePicker(boxId: string): Promise<void> {
    const box = boxes.find((item) => item.id === boxId);
    if (!box || box.type !== 'SS') {
        return;
    }

    const sources = await window.liveGallery.getDesktopSources();
    const overlay = document.createElement('section');
    overlay.className =
        'fixed inset-0 z-300 grid place-items-center bg-black/60 p-4 backdrop-blur-sm';
    overlay.setAttribute('aria-label', 'Select a screen or window');
    overlay.innerHTML = `
        <div class="bg-surface grid h-[min(760px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] grid-rows-[auto_1fr] gap-4 rounded-[14px] border border-white/10 p-5 shadow-2xl shadow-black/60">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <h2 class="truncate text-[15px] font-semibold">Select a screen or window</h2>
            <div class="flex gap-2">
              <button type="button" class="screen-picker-reset btn btn-gray">Reset</button>
              <button type="button" class="screen-picker-cancel btn btn-gray">Cancel</button>
            </div>
          </div>
          <div class="screen-picker-sources grid min-h-0 auto-rows-min grid-cols-[repeat(auto-fill,minmax(280px,1fr))] content-start gap-3 overflow-auto pr-1"></div>
        </div>
    `;

    const close = (): void => overlay.remove();
    const renderSources = (items: DesktopSource[]): void => {
        const sourcesNode = overlay.querySelector<HTMLElement>('.screen-picker-sources')!;
        sourcesNode.replaceChildren();
        const selected = findSavedDesktopSource(items, parseScreenShareValue(box.value));
        items.forEach((source) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = [
                'grid',
                'grid-rows-[auto_1.25rem]',
                'gap-2',
                'rounded-[10px]',
                'p-2',
                'text-left',
                'text-xs',
                'text-label',
                'transition',
                source === selected
                    ? 'bg-accent/20 ring-2 ring-accent'
                    : 'bg-surface-2 hover:bg-surface-3',
            ].join(' ');

            const image = document.createElement('img');
            image.alt = '';
            image.src = source.thumbnail;
            image.className = 'aspect-video w-full rounded-md bg-black object-contain';

            const label = document.createElement('span');
            label.className = 'truncate';
            label.textContent = source.name;

            button.title = source.name;
            button.append(image, label);
            button.addEventListener('click', () => {
                sendCommand(boxId, { type: 'start-screen-share', source });
                close();
            });
            sourcesNode.appendChild(button);
        });
    };

    overlay
        .querySelector<HTMLButtonElement>('.screen-picker-cancel')!
        .addEventListener('click', close);
    overlay
        .querySelector<HTMLButtonElement>('.screen-picker-reset')!
        .addEventListener('click', () => {
            resetScreenShareSource(box);
            close();
        });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            close();
        }
    });

    renderSources(sources);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('.screen-picker-cancel')!.focus();
}

function findSavedDesktopSource(
    sources: DesktopSource[],
    saved: ScreenShareValue,
): DesktopSource | null {
    return sources.find((source) => source.id === saved.sourceId) ?? null;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}

async function loadMics(): Promise<void> {
    if (mics.length > 0) {
        return;
    }

    if (micsPromise) {
        return micsPromise;
    }

    micsPromise = loadMicsOnce().finally(() => {
        micsPromise = null;
    });
    return micsPromise;
}

async function loadMicsOnce(): Promise<void> {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false,
            },
        });
        stream.getTracks().forEach((track) => track.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        mics = devices
            .filter((device) => device.kind === 'audioinput')
            .sort((a, b) =>
                a.label.localeCompare(b.label, undefined, {
                    numeric: true,
                    sensitivity: 'base',
                }),
            );
    } catch (error) {
        console.error('Error accessing microphones:', error);
    }
}

function setEditing(form: HTMLFormElement, isEditing: boolean): void {
    form.classList.toggle('hidden', !isEditing);
    form.classList.toggle('grid', isEditing);
}

function syncMuteButtonTitle(button: HTMLButtonElement, isMuted: boolean): void {
    const label = isMuted ? 'Unmute this box' : 'Mute this box';
    button.title = label;
    button.setAttribute('aria-label', label);
}

function syncExpandButtonTitle(button: HTMLButtonElement, root: HTMLElement): void {
    const label = root.classList.contains('box-expanded') ? 'Collapse this box' : 'Expand this box';
    button.title = label;
    button.setAttribute('aria-label', label);
}

function setUnmuted(root: HTMLElement, isUnmuted: boolean): void {
    root.classList.toggle('box-unmuted', isUnmuted);
}

function toggleExpanded(root: HTMLElement): void {
    root.classList.toggle('box-expanded');
}

function closeExpandedBox(): boolean {
    const root = gallery.querySelector<HTMLElement>('.box-expanded');
    if (!root) {
        return false;
    }

    root.classList.remove('box-expanded');
    const expandButton = root.querySelector<HTMLButtonElement>('.expand');
    if (expandButton) {
        syncExpandButtonTitle(expandButton, root);
    }
    return true;
}

function updateBoxNumbers(): void {
    boxes.forEach((box, index) => {
        elements.get(box.id)!.number.textContent = String(index + 1);
    });
}

function loadWebview(box: GalleryBox, forceReload = false): void {
    const entry = elements.get(box.id);
    if (!entry) {
        return;
    }

    const src = getPlayerUrl(box, settings);
    entry.emptyState.classList.toggle('hidden', Boolean(src));
    entry.webview.classList.toggle('hidden', !src);

    if (!src) {
        return;
    }

    if (entry.webview.getAttribute('src') === src) {
        if (forceReload) {
            alertController.clearBox(box.id);
            if (entry.webviewReady) {
                entry.webview.reloadIgnoringCache();
            }
        }
        return;
    }

    entry.webviewReady = false;
    entry.pendingCommands = [];
    alertController.clearBox(box.id);
    entry.webview.src = src;
}

function flushPendingCommands(entry: BoxElements): void {
    const commands = entry.pendingCommands.splice(0);
    commands.forEach((command) => {
        entry.webview.send('gallery-command', command);
    });
}

function sendCommand(boxId: string, command: Record<string, unknown>): void {
    const entry = elements.get(boxId);
    if (!entry) {
        return;
    }

    if (!entry.webviewReady) {
        entry.pendingCommands.push(command);
        return;
    }

    try {
        entry.webview.send('gallery-command', command);
    } catch (error) {
        entry.webviewReady = false;
        entry.pendingCommands.push(command);
        console.warn(`Box ${boxId} is not ready for player command yet:`, error);
    }
}

function syncAudioCommands(box: GalleryBox): void {
    sendCommand(box.id, {
        type: 'audio-levels',
        enabled: settings.audioLevels,
        phaseMetricsEnabled: settings.alertAudioPhaseMismatch,
    });
    sendCommand(box.id, { type: 'mono-output', enabled: settings.monoOutput });
}

function toggleMute(boxId: string, forceMuted?: boolean): void {
    const box = boxes.find((item) => item.id === boxId);
    const entry = elements.get(boxId);
    if (!box || !entry) {
        return;
    }

    box.muted = forceMuted ?? !box.muted;
    setUnmuted(entry.root, !box.muted);
    entry.muteButton.innerHTML = icon(box.muted ? 'volume-x' : 'volume-2');
    syncMuteButtonTitle(entry.muteButton, box.muted);
    sendCommand(box.id, { type: 'mute', muted: box.muted });
    saveState();
}

function soloBox(boxId: string): void {
    const box = boxes.find((item) => item.id === boxId);
    if (!box) {
        return;
    }

    const alreadySolo = !box.muted && boxes.every((item) => item.id === boxId || item.muted);

    if (alreadySolo) {
        toggleMute(boxId, true);
        return;
    }

    boxes.forEach((item) => toggleMute(item.id, item.id !== boxId));
}

function disableRotationAudio(): void {
    if (!settings.muteRotation && !muteRotationInput.checked) {
        return;
    }

    muteRotationInput.checked = false;
    updateAllSettings();
}

function copyBoxUrl(box: GalleryBox): void {
    const url = getSourceUrl(box, settings);
    if (!url) {
        showToast(box.type === 'SS' ? 'Screen share has no URL' : 'No URL to copy', 'error');
        return;
    }

    window.liveGallery
        .copyText(url)
        .then(() => showToast('URL copied'))
        .catch((error: unknown) => {
            console.error('Could not copy URL:', error);
            showToast('Could not copy URL', 'error');
        });
}

function removeBox(boxId: string): void {
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index >= 0) {
        const [removed] = boxes.splice(index, 1);
        elements.get(removed.id)?.root.remove();
        elements.delete(removed.id);
        meterClipHoldUntil.delete(removed.id);
        meterStates.delete(removed.id);
        alertController.clearBox(removed.id);

        if (boxes.length === 0) {
            addBox();
            return;
        }
        updateBoxNumbers();
        saveState();
        restartRotation();
    }
}

function moveBox(sourceId: string, targetId: string): void {
    if (!sourceId || sourceId === targetId) {
        return;
    }

    const sourceIndex = boxes.findIndex((box) => box.id === sourceId);
    const targetIndex = boxes.findIndex((box) => box.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
        return;
    }

    const [source] = boxes.splice(sourceIndex, 1);
    boxes.splice(targetIndex, 0, source);
    const sourceRoot = elements.get(sourceId)!.root;
    const nextBox = boxes[targetIndex + 1];
    gallery.insertBefore(sourceRoot, nextBox ? elements.get(nextBox.id)!.root : null);
    updateBoxNumbers();
    saveState();
    restartRotation();
}

function updateMeter(canvas: HTMLCanvasElement, payload: LevelPayload): void {
    if (!settings.audioLevels) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        meterClipHoldUntil.delete(payload.boxId);
        meterStates.delete(payload.boxId);
        return;
    }

    updateMeterClipHold(payload);
    const state = meterStates.get(payload.boxId) ?? {
        canvas,
        latest: { left: meterFloorDb, right: meterFloorDb },
        shown: { left: meterFloorDb, right: meterFloorDb },
        dirty: true,
    };
    state.canvas = canvas;
    state.latest = { left: payload.left, right: payload.right };
    state.shown.left = Math.max(state.shown.left, payload.left);
    state.shown.right = Math.max(state.shown.right, payload.right);
    state.dirty = true;
    meterStates.set(payload.boxId, state);

    if (!meterFrame) {
        lastMeterFrameAt = performance.now();
        meterFrame = requestAnimationFrame(stepMeters);
    }
}

function stepMeters(now: number): void {
    const elapsed = now - lastMeterFrameAt;
    if (elapsed < meterFrameMs) {
        meterFrame = requestAnimationFrame(stepMeters);
        return;
    }

    lastMeterFrameAt = now;
    const fall = (Math.min(elapsed, 250) / 1000) * meterReleaseDbPerSecond;
    let falling = false;

    meterStates.forEach((state, boxId) => {
        const left = Math.max(state.latest.left, state.shown.left - fall);
        const right = Math.max(state.latest.right, state.shown.right - fall);
        if (left !== state.shown.left || right !== state.shown.right) {
            state.shown = { left, right };
            state.dirty = true;
        }
        if (state.dirty) {
            drawMeter(state, boxId);
            state.dirty = false;
        }
        falling ||= left > state.latest.left || right > state.latest.right;
    });

    meterFrame = falling ? requestAnimationFrame(stepMeters) : 0;
}

function drawMeter(state: MeterState, boxId: string): void {
    const context = state.canvas.getContext('2d');
    if (!context) {
        return;
    }

    context.clearRect(0, 0, state.canvas.width, state.canvas.height);
    drawChannel(context, 0, state.shown.left);
    drawChannel(context, state.canvas.width / 2, state.shown.right);
    drawClipHoldTiles(context, boxId);
}

function updateMeterClipHold(payload: LevelPayload): void {
    const now = performance.now();
    const hold = meterClipHoldUntil.get(payload.boxId) ?? { left: 0, right: 0 };
    const holdUntil = now + 2000;

    if (payload.left >= audioClippingDb) {
        hold.left = holdUntil;
    }
    if (payload.right >= audioClippingDb) {
        hold.right = holdUntil;
    }

    meterClipHoldUntil.set(payload.boxId, hold);
}

function drawClipHoldTiles(context: CanvasRenderingContext2D, boxId: string): void {
    const hold = meterClipHoldUntil.get(boxId);
    if (!hold) {
        return;
    }

    const now = performance.now();
    const width = context.canvas.width / 2;
    const height = Math.max(2, Math.round(context.canvas.height * 0.03));

    context.fillStyle = '#ff0000';
    if (hold.left > now) {
        context.fillRect(0, 0, width, height);
    }
    if (hold.right > now) {
        context.fillRect(width, 0, width, height);
    }
}

function drawChannel(context: CanvasRenderingContext2D, x: number, db: number): void {
    const ranges = [
        { min: -91, max: -90, fraction: 0.07, color: '#008000' },
        { min: -90, max: -36, fraction: 0.28, color: '#008000' },
        { min: -36, max: -18, fraction: 0.25, color: '#00c000' },
        { min: -18, max: -6, fraction: 0.25, color: '#00ff00' },
        { min: -6, max: -1, fraction: 0.12, color: '#ffff00' },
        { min: -1, max: 0, fraction: 0.03, color: '#ff0000' },
    ];
    const width = context.canvas.width / 2;
    const height = context.canvas.height;
    let accumulatedHeight = 0;

    ranges.forEach((range) => {
        if (db >= range.min) {
            const rangeHeight = range.fraction * height;
            const filledFraction = Math.min(db, range.max) - range.min;
            const filledHeight = (filledFraction / (range.max - range.min)) * rangeHeight;

            context.fillStyle = range.color;
            context.fillRect(x, height - accumulatedHeight - filledHeight, width, filledHeight);
            accumulatedHeight += rangeHeight;
        }
    });
}

function restartRotation(): void {
    window.clearInterval(rotationTimer);
    if (!settings.muteRotation) {
        return;
    }

    let index = 0;
    const rotate = (): void => {
        const selected = getRotationBoxes();
        if (selected.length === 0) {
            return;
        }
        if (selected.length === 1) {
            toggleMute(selected[0].id, false);
            return;
        }
        soloBox(selected[index % selected.length].id);
        index += 1;
    };

    rotate();
    rotationTimer = window.setInterval(rotate, Math.max(1, settings.rotationTime) * 1000);
}

function getRotationBoxes(): GalleryBox[] {
    if (settings.rotationBoxes.trim() === '') {
        return boxes;
    }

    if (getRotationBoxesSyntaxError(settings.rotationBoxes)) {
        return [];
    }

    const numbers = parseRotationNumbers(settings.rotationBoxes);

    return numbers
        .map((number) => boxes[number - 1])
        .filter((box): box is GalleryBox => Boolean(box));
}

function parseRotationNumbers(value: string): number[] {
    return value.split(/\s+/).flatMap((token) => {
        const match = token.match(/^(\d+)(?:-(\d+))?$/);
        if (!match) {
            return [];
        }

        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : start;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0) {
            return [];
        }

        const range: number[] = [];
        for (let current = start; current <= end; current += 1) {
            range.push(current);
        }
        return range;
    });
}

function updateAllSettings(): void {
    sanitizeRotationBoxesInput();
    syncSettingsFromControls();
    syncRotationControlsVisibility();
    alertController.clearDisabled();
    boxes.forEach((box) => {
        sendCommand(box.id, { type: 'auto-live', enabled: settings.autoLive });
        syncAudioCommands(box);
    });
    saveState();
    restartRotation();
}

function saveSettingsFromDialog(): void {
    const previousJwServerHost = settings.jwServerHost;
    syncSettingsFromControls();
    alertController.clearDisabled();
    boxes.forEach(syncAudioCommands);
    applyUiZoom();
    saveState();

    if (settings.jwServerHost !== previousJwServerHost) {
        boxes.filter((box) => box.type === 'JW').forEach((box) => loadWebview(box));
    }

    showToast('Settings saved');
}

function showToast(message: string, variant: 'success' | 'primary' | 'error' = 'success'): void {
    window.clearTimeout(clipboardToastTimer);
    clipboardToastIcon.innerHTML = icon(variant === 'error' ? 'circle-alert' : 'check', 'h-4 w-4');
    clipboardToastText.textContent = message;
    clipboardToast.dataset.variant = variant;
    clipboardToast.classList.remove('hidden');
    clipboardToastTimer = window.setTimeout(() => {
        clipboardToast.classList.add('hidden');
    }, 1800);
}

document.getElementById('add-box')!.addEventListener('click', () => {
    addBox();
});

document.getElementById('docs-button')!.addEventListener('click', () => {
    presetMenu.open = false;
    // The main process opens every window.open URL in the default browser.
    window.open(DOCS_URL, '_blank', 'noopener');
});

alertsButton.addEventListener('click', () => {
    presetMenu.open = false;
    alertController.render();
    alertsDialog.showModal();
});

document.getElementById('settings-button')!.addEventListener('click', () => {
    syncControlsFromSettings();
    settingsDialog.showModal();
    requestAnimationFrame(() => {
        jwServerHostInput.focus();
        jwServerHostInput.select();
    });
});

settingsForm.addEventListener('submit', (event) => {
    const submitter = (event as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement && submitter.value === 'default') {
        saveSettingsFromDialog();
    } else {
        syncControlsFromSettings();
    }
});

maxVolumeButton.addEventListener('click', () => {
    boxes.forEach((box) => sendCommand(box.id, { type: 'max-volume' }));
    showToast('YouTube volume set to max', 'primary');
});

document.getElementById('lowest-quality')!.addEventListener('click', () => {
    boxes.forEach((box) => sendCommand(box.id, { type: 'lowest-quality' }));
    showToast('YouTube quality set to lowest', 'primary');
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && closeExpandedBox()) {
        event.preventDefault();
        event.stopPropagation();
    }
});

alertSoundButton.addEventListener('click', toggleAlertSound);
alertSoundControl.addEventListener('pointerenter', openAlertVolume);
alertSoundControl.addEventListener('pointerleave', closeAlertVolumeSoon);
alertSoundControl.addEventListener('focusin', () => {
    if (alertVolumeReturningFocus) {
        alertVolumeReturningFocus = false;
        return;
    }
    if (alertSoundControl.querySelector(':focus-visible')) {
        openAlertVolume();
    }
});
alertSoundControl.addEventListener('focusout', (event) => {
    if (!alertSoundControl.contains(event.relatedTarget as Node | null)) {
        closeAlertVolume();
    }
});
alertSoundControl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeAlertVolume();
        // Returning focus to the bell must not reopen the popover.
        alertVolumeReturningFocus = document.activeElement !== alertSoundButton;
        alertSoundButton.focus();
    }
});
alertVolumeInput.addEventListener('input', setAlertVolumeFromSlider);
alertVolumeInput.addEventListener('change', () => {
    saveState();
    alertController.render();
});
audioOutputButton.addEventListener('click', toggleMonoOutput);

[muteRotationInput, rotationBoxesInput, rotationTimeInput, autoLiveInput].forEach((input) => {
    input.addEventListener('change', updateAllSettings);
});
rotationBoxesInput.addEventListener('input', sanitizeRotationBoxesInput);

initWindowControls();
initPresetMenuControls();
initZoomControls();
initUpdateControls();
loadMics().catch((error) => {
    console.error('Error preloading microphones:', error);
});
loadState();
applyBoxZoom();
applyUiZoom();
render();
presetController.refresh();
