import {
    BoxType,
    GalleryBox,
    GallerySettings,
    deserializeBoxes,
    extractYouTubeId,
    getPlayerUrl,
    makeBox,
} from './utils.js';
import { createAlertController, type HealthPayload, type LevelPayload } from './alerts.js';
import { createPresetController } from './presets.js';

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
    webviewReady: boolean;
    pendingCommands: Record<string, unknown>[];
};

const boxes: GalleryBox[] = [];
const elements = new Map<string, BoxElements>();
let mics: MediaDeviceInfo[] = [];
let rotationTimer = 0;
let clipboardToastTimer = 0;
let draggedId = '';
let micsPromise: Promise<void> | null = null;
let currentZoomPercent = 100;

const gallery = mustGet<HTMLElement>('gallery');
const muteRotationInput = mustGet<HTMLInputElement>('mute-rotation');
const rotationBoxesInput = mustGet<HTMLInputElement>('rotation-boxes');
const rotationTimeInput = mustGet<HTMLInputElement>('rotation-time');
const autoLiveInput = mustGet<HTMLInputElement>('auto-live');
const alertSoundInput = mustGet<HTMLInputElement>('alert-sound');
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
const presetMenu = mustGet<HTMLDetailsElement>('preset-menu');
const savedPresetList = mustGet<HTMLElement>('saved-preset-list');
const newPresetButton = mustGet<HTMLButtonElement>('new-preset');
const exportPresetButton = mustGet<HTMLButtonElement>('export-preset');
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
const clipboardToastAlert = mustGet<HTMLElement>('clipboard-toast-alert');
const clipboardToastText = mustGet<HTMLElement>('clipboard-toast-text');
const presetNameDialog = mustGet<HTMLDialogElement>('preset-name-dialog');
const presetNameTitle = mustGet<HTMLElement>('preset-name-title');
const presetNameInput = mustGet<HTMLInputElement>('preset-name-input');
const docsDialog = mustGet<HTMLDialogElement>('docs-dialog');
const alertsDialog = mustGet<HTMLDialogElement>('alerts-dialog');
const alertsList = mustGet<HTMLElement>('alerts-list');
const settingsDialog = mustGet<HTMLDialogElement>('settings-dialog');
const settingsForm = mustGet<HTMLFormElement>('settings-form');
const jwServerHostInput = mustGet<HTMLInputElement>('jw-server-host');

const settings: GallerySettings = {
    audioLevels: true,
    muteRotation: false,
    rotationBoxes: '',
    rotationTime: 5,
    autoLive: true,
    jwServerHost: 'https://your.website.com/Player/Index/',
    alertSound: true,
    alertVideoBuffering: true,
    alertVideoRepeatedBuffering: true,
    alertVideoFrozen: true,
    alertAudioSilent: true,
    alertAudioDropouts: true,
    alertAudioClipping: true,
    alertAudioChannelMissing: true,
    alertAudioImbalance: true,
};

const minZoomPercent = 20;
const maxZoomPercent = 300;
const zoomFitMarginPx = 16;

const fullscreenIcon = `
    <svg
      aria-hidden="true"
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
`;

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

function setZoomStatus(percent: number): void {
    currentZoomPercent = percent;
    zoomStatusButton.textContent = `${percent}%`;
    zoomOutButton.disabled = percent <= minZoomPercent;
    zoomInButton.disabled = percent >= maxZoomPercent || getHorizontalBoxCapacity(percent) <= 1;
}

function getBoxTitle(box: GalleryBox): string {
    return box.name ? `${box.type}: ${box.name}` : box.type;
}

function initZoomControls(): void {
    window.liveGallery.getZoom().then(setZoomStatus).catch(console.error);
    window.liveGallery.onZoomChanged(setZoomStatus);

    zoomOutButton.addEventListener('click', () => {
        setZoomForHorizontalBoxDelta(1).catch(console.error);
    });
    zoomInButton.addEventListener('click', () => {
        setZoomForHorizontalBoxDelta(-1).catch(console.error);
    });
    zoomStatusButton.addEventListener('click', () => {
        window.liveGallery.setZoom(100).then(setZoomStatus).catch(console.error);
    });
}

function getBoxOuterWidth(): number {
    const box = elements.values().next().value?.root;
    if (!box) {
        return 287;
    }

    const style = window.getComputedStyle(box);
    return box.offsetWidth + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
}

function getFallbackContentWidth(): number {
    return Math.round((document.documentElement.clientWidth * currentZoomPercent) / 100);
}

async function getContentWidth(): Promise<number> {
    const width = await window.liveGallery.getContentWidth();
    return width > 0 ? width : getFallbackContentWidth();
}

function getHorizontalBoxCapacity(
    zoomPercent: number,
    contentWidth = getFallbackContentWidth(),
): number {
    const boxWidth = getBoxOuterWidth();
    const viewportWidth = (contentWidth * 100) / zoomPercent;
    return Math.max(1, Math.floor((viewportWidth - zoomFitMarginPx) / boxWidth));
}

function getZoomForHorizontalBoxCapacity(capacity: number, contentWidth: number): number {
    const requiredWidth = capacity * getBoxOuterWidth() + zoomFitMarginPx;
    let zoom = Math.max(
        minZoomPercent,
        Math.min(maxZoomPercent, Math.floor((contentWidth * 100) / requiredWidth)),
    );

    while (zoom > minZoomPercent && getHorizontalBoxCapacity(zoom, contentWidth) < capacity) {
        zoom -= 1;
    }

    while (zoom < maxZoomPercent && getHorizontalBoxCapacity(zoom + 1, contentWidth) >= capacity) {
        zoom += 1;
    }

    return zoom;
}

async function setZoomForHorizontalBoxDelta(deltaBoxes: -1 | 1): Promise<void> {
    const contentWidth = await getContentWidth();
    const currentCapacity = getHorizontalBoxCapacity(currentZoomPercent, contentWidth);
    const targetCapacity = currentCapacity + deltaBoxes;
    if (targetCapacity < 1) {
        return;
    }

    const targetZoom = getZoomForHorizontalBoxCapacity(targetCapacity, contentWidth);

    if (targetZoom === currentZoomPercent) {
        return;
    }

    const appliedZoom = await window.liveGallery.setZoom(targetZoom);
    setZoomStatus(appliedZoom);
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
    settings.alertSound = alertSoundInput.checked;
    settings.alertVideoBuffering = alertVideoBufferingInput.checked;
    settings.alertVideoRepeatedBuffering = alertVideoRepeatedBufferingInput.checked;
    settings.alertVideoFrozen = alertVideoFrozenInput.checked;
    settings.alertAudioSilent = alertAudioSilentInput.checked;
    settings.alertAudioDropouts = alertAudioDropoutsInput.checked;
    settings.alertAudioClipping = alertAudioClippingInput.checked;
    settings.alertAudioChannelMissing = alertAudioChannelMissingInput.checked;
    settings.alertAudioImbalance = alertAudioImbalanceInput.checked;
}

function syncControlsFromSettings(): void {
    muteRotationInput.checked = settings.muteRotation;
    rotationBoxesInput.value = settings.rotationBoxes;
    rotationTimeInput.value = String(settings.rotationTime);
    autoLiveInput.checked = settings.autoLive;
    jwServerHostInput.value = settings.jwServerHost;
    alertSoundInput.checked = settings.alertSound;
    alertVideoBufferingInput.checked = settings.alertVideoBuffering;
    alertVideoRepeatedBufferingInput.checked = settings.alertVideoRepeatedBuffering;
    alertVideoFrozenInput.checked = settings.alertVideoFrozen;
    alertAudioSilentInput.checked = settings.alertAudioSilent;
    alertAudioDropoutsInput.checked = settings.alertAudioDropouts;
    alertAudioClippingInput.checked = settings.alertAudioClipping;
    alertAudioChannelMissingInput.checked = settings.alertAudioChannelMissing;
    alertAudioImbalanceInput.checked = settings.alertAudioImbalance;
    syncRotationControlsVisibility();
    updateRotationBoxesValidity();
}

function syncRotationControlsVisibility(): void {
    const isRotating = muteRotationInput.checked;
    rotationBoxesInput.disabled = !isRotating;
    rotationTimeInput.disabled = !isRotating;
}

function sanitizeRotationBoxesInput(): void {
    rotationBoxesInput.value = rotationBoxesInput.value.replace(/[^\d\s-]/g, ' ');
    updateRotationBoxesValidity();
}

function updateRotationBoxesValidity(): boolean {
    const error = getRotationBoxesSyntaxError(rotationBoxesInput.value);
    rotationBoxesInput.classList.toggle('input-error', Boolean(error));
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
    settings.alertSound = storedSettings.alertSound ?? true;
    settings.alertVideoBuffering = storedSettings.alertVideoBuffering ?? true;
    settings.alertVideoRepeatedBuffering = storedSettings.alertVideoRepeatedBuffering ?? true;
    settings.alertVideoFrozen = storedSettings.alertVideoFrozen ?? true;
    settings.alertAudioSilent = storedSettings.alertAudioSilent ?? true;
    settings.alertAudioDropouts = storedSettings.alertAudioDropouts ?? true;
    settings.alertAudioClipping = storedSettings.alertAudioClipping ?? true;
    settings.alertAudioChannelMissing = storedSettings.alertAudioChannelMissing ?? true;
    settings.alertAudioImbalance = storedSettings.alertAudioImbalance ?? true;
    syncControlsFromSettings();
    boxes.splice(0, boxes.length, ...(sharedBoxes.length > 0 ? sharedBoxes : storedBoxes));

    if (boxes.length === 0) {
        boxes.push(makeBox());
    }
}

function render(): void {
    gallery.replaceChildren();
    elements.clear();
    boxes.forEach((box, index) => renderBox(box, index));
    alertController.resetAll();
    saveState();
    restartRotation();
}

function addBox(): void {
    const box = makeBox();
    boxes.push(box);
    renderBox(box, boxes.length - 1);
    saveState();
    restartRotation();
}

function renderBox(box: GalleryBox, index: number): void {
    const root = document.createElement('article');
    root.className =
        'bg-base-200 border-base-content/25 relative m-1 h-fit w-[279px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border shadow-md shadow-black/50';
    root.innerHTML = `
        <div class="box-header group bg-base-300 border-base-content/10 relative flex h-5 w-full items-center overflow-hidden border-b">
          <button class="drag-handle btn btn-ghost btn-xs box-tool-btn relative z-20 cursor-grab" title="Drag">☰</button>
          <span class="box-number absolute top-0 left-7 z-20 h-5 cursor-grab select-none text-sm leading-5 font-semibold" title="Drag"></span>
          <strong class="box-title bg-base-300 pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8 text-center text-sm font-semibold whitespace-nowrap group-hover:hidden group-focus-within:hidden"></strong>
          <button class="expand btn btn-secondary btn-xs btn-soft box-tool-btn box-tool-btn-first" title="Expand" aria-label="Expand">${fullscreenIcon}</button>
          <button class="mute btn btn-xs btn-soft box-tool-btn" title="Mute or unmute">🔇</button>
          <button class="solo btn btn-secondary btn-xs btn-soft box-tool-btn" title="Solo this box">S</button>
          <button class="edit btn btn-secondary btn-xs btn-soft box-tool-btn" title="Edit">✎</button>
          <button class="reload btn btn-secondary btn-xs btn-soft box-tool-btn" title="Reload">↻</button>
          <button class="remove btn btn-error btn-xs btn-soft box-tool-btn" title="Remove">✕</button>
        </div>
        <form class="box-form bg-base-200/80 border-base-300 absolute top-7 left-1/2 z-20 hidden w-4/5 -translate-x-1/2 grid-cols-1 gap-1 rounded-lg border p-2 shadow-lg backdrop-blur-sm">
          <input name="name" class="input input-xs" type="text" placeholder="Name" />
          <select name="type" class="select select-xs">
            <option value="YT">YouTube</option>
            <option value="JW">JW Player</option>
            <option value="VC">VdoCipher</option>
            <option value="SS">Screen Share</option>
            <option value="CU">Custom URL</option>
          </select>
          <div class="value-slot"></div>
          <div class="mt-1 flex justify-center gap-2">
            <button type="button" class="cancel btn btn-error btn-soft btn-xs min-w-16">Cancel</button>
            <button type="submit" class="btn btn-secondary btn-xs min-w-16">Save</button>
          </div>
        </form>
        <div class="viewport bg-base-200 relative h-37.5 overflow-hidden">
          <div class="absolute top-0 right-2.5 bottom-0 left-0 overflow-hidden">
            <webview class="player bg-neutral absolute top-0 left-0 h-[160%] w-[160%] origin-top-left scale-[0.625]" style="color-scheme: light" allowpopups></webview>
          </div>
          <canvas class="meter pointer-events-none absolute top-0 right-0 h-full w-2.5 bg-black/30" width="10" height="180"></canvas>
          <div class="empty-state text-base-content/60 pointer-events-none absolute inset-0 grid place-items-center p-5 text-center">Configure this box to load a live source.</div>
        </div>`;

    const title = root.querySelector<HTMLElement>('.box-title')!;
    const number = root.querySelector<HTMLElement>('.box-number')!;
    const form = root.querySelector<HTMLFormElement>('.box-form')!;
    const viewport = root.querySelector<HTMLElement>('.viewport')!;
    const emptyState = root.querySelector<HTMLElement>('.empty-state')!;
    const webview = root.querySelector<Electron.WebviewTag>('webview')!;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
    const muteButton = root.querySelector<HTMLButtonElement>('.mute')!;

    root.dataset.id = box.id;
    root.draggable = true;
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
            webviewReady: false,
            pendingCommands: [],
        },
        box,
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
            drawMeter(canvas, payload);
            alertController.updateAudioHealth(payload);
        } else if (event.channel === 'gallery-health') {
            alertController.updateFromHealth(event.args[0] as HealthPayload);
        } else if (event.channel === 'gallery-error') {
            console.warn(`Box ${box.name || box.id} player error:`, event.args[0]);
        } else if (event.channel === 'gallery-screen-share-source') {
            rememberScreenShareSource(box, event.args[0] as Partial<DesktopSource>);
        } else if (event.channel === 'gallery-open-screen-share-picker') {
            openScreenSharePicker(box.id).catch((error) => {
                console.error('Could not open screen share picker:', error);
                showToast('Could not load windows', 'error');
            });
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

    root.querySelector<HTMLButtonElement>('.expand')!.addEventListener('click', () => {
        toggleExpanded(root, viewport);
    });
    root.querySelector<HTMLButtonElement>('.edit')!.addEventListener('click', () => {
        setEditing(form, true);
    });
    root.querySelector<HTMLButtonElement>('.reload')!.addEventListener('click', () =>
        loadWebview(box, true),
    );
    root.querySelector<HTMLButtonElement>('.remove')!.addEventListener('click', () =>
        removeBox(box.id),
    );
    root.querySelector<HTMLButtonElement>('.solo')!.addEventListener('click', () => {
        disableRotationAudio();
        soloBox(box.id);
    });
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
        draggedId = box.id;
        root.classList.add('box-dragging');
        gallery.classList.add('gallery-dragging');
        event.dataTransfer?.setData('text/plain', box.id);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
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
                webviewReady: false,
                pendingCommands: [],
            },
            box,
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
        webviewReady: false,
        pendingCommands: [],
    });
    loadWebview(box);
}

function syncBoxControls(entry: BoxElements, box: GalleryBox): void {
    entry.title.textContent = getBoxTitle(box);
    entry.muteButton.textContent = box.muted ? '🔇' : '🔈';
    setUnmuted(entry.root, !box.muted);
    setEditing(entry.form, !box.value);

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
            ? `<select name="value" class="select select-xs">
                <option value="${escapeAttribute(serializeScreenShareValue({ ...screenShareValue, micDeviceId: '' }))}">Display audio / default</option>
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
            : `<input name="value" class="input input-xs" type="text" placeholder="URL or ID" value="${escapeAttribute(value)}" />`;
    const control = form.elements.namedItem('value');
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
        control.addEventListener('input', () => clearBoxValueError(form));
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

function requiresBoxValue(type: BoxType): boolean {
    return type !== 'SS';
}

function showBoxValueError(form: HTMLFormElement): void {
    const control = form.elements.namedItem('value');
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
        return;
    }

    control.classList.toggle('input-error', control instanceof HTMLInputElement);
    control.classList.toggle('select-error', control instanceof HTMLSelectElement);
    control.setAttribute('aria-invalid', 'true');
    control.title = 'URL or ID is required.';
    control.focus();
}

function clearBoxValueError(form: HTMLFormElement): void {
    const control = form.elements.namedItem('value');
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
        return;
    }

    control.classList.remove('input-error', 'select-error');
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
        'fixed inset-0 z-300 grid place-items-center bg-black/85 p-4 backdrop-blur-sm';
    overlay.setAttribute('aria-label', 'Select a screen or window');
    overlay.innerHTML = `
        <div class="grid h-[min(760px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] grid-rows-[auto_1fr] gap-3 rounded-lg border border-base-content/25 bg-base-200 p-4 shadow-2xl shadow-black/70">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <h2 class="truncate text-lg font-semibold">Select a screen or window</h2>
            <div class="flex gap-2">
              <button type="button" class="screen-picker-cancel btn btn-error btn-soft btn-sm">Cancel</button>
              <button type="button" class="screen-picker-reset btn btn-secondary btn-sm btn-soft">Reset</button>
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
                'rounded-md',
                'border',
                'p-1.5',
                'text-left',
                'text-sm',
                'text-base-content',
                'transition',
                source === selected
                    ? 'border-secondary bg-secondary/20'
                    : 'border-base-content/20 bg-base-300/70 hover:border-secondary/80 hover:bg-base-300',
            ].join(' ');

            const image = document.createElement('img');
            image.alt = '';
            image.src = source.thumbnail;
            image.className = 'aspect-video w-full rounded bg-black object-contain';

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

function setUnmuted(root: HTMLElement, isUnmuted: boolean): void {
    root.classList.toggle('outline-secondary', isUnmuted);
    root.classList.toggle('outline-4', isUnmuted);
}

function toggleExpanded(root: HTMLElement, viewport: HTMLElement): void {
    const isExpanded = !root.classList.contains('box-expanded');
    root.classList.toggle('box-expanded', isExpanded);
    viewport.classList.toggle('h-37.5', !isExpanded);
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

function toggleMute(boxId: string, forceMuted?: boolean): void {
    const box = boxes.find((item) => item.id === boxId);
    const entry = elements.get(boxId);
    if (!box || !entry) {
        return;
    }

    box.muted = forceMuted ?? !box.muted;
    setUnmuted(entry.root, !box.muted);
    entry.muteButton.textContent = box.muted ? '🔇' : '🔈';
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

function removeBox(boxId: string): void {
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index >= 0) {
        const [removed] = boxes.splice(index, 1);
        elements.get(removed.id)?.root.remove();
        elements.delete(removed.id);
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

function drawMeter(canvas: HTMLCanvasElement, payload: LevelPayload): void {
    if (!settings.audioLevels) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    drawChannel(context, 0, payload.left);
    drawChannel(context, canvas.width / 2, payload.right);
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
    });
    saveState();
    restartRotation();
}

function saveSettingsFromDialog(): void {
    const previousJwServerHost = settings.jwServerHost;
    syncSettingsFromControls();
    alertController.clearDisabled();
    saveState();

    if (settings.jwServerHost !== previousJwServerHost) {
        boxes.filter((box) => box.type === 'JW').forEach((box) => loadWebview(box));
    }

    showToast('Settings saved');
}

function showToast(message: string, variant: 'success' | 'error' = 'success'): void {
    window.clearTimeout(clipboardToastTimer);
    clipboardToastText.textContent = message;
    clipboardToastAlert.classList.toggle('alert-success', variant === 'success');
    clipboardToastAlert.classList.toggle('alert-error', variant === 'error');
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
    docsDialog.showModal();
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

document.getElementById('lowest-quality')!.addEventListener('click', () => {
    boxes.forEach((box) => sendCommand(box.id, { type: 'lowest-quality' }));
});

alertSoundInput.addEventListener('change', () => {
    settings.alertSound = alertSoundInput.checked;
    saveState();
    alertController.render();
});

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
render();
presetController.refresh();
