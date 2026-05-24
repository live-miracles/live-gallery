import {
    BoxType,
    GalleryBox,
    GallerySettings,
    deserializeBoxes,
    extractYouTubeId,
    getPlayerUrl,
    makeBox,
    parseSheetRows,
    serializeBoxes,
} from './utils.js';

type LevelPayload = {
    boxId: string;
    left: number;
    right: number;
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
let draggedId = '';

const gallery = mustGet<HTMLElement>('gallery');
const muteRotationInput = mustGet<HTMLInputElement>('mute-rotation');
const rotationBoxesInput = mustGet<HTMLInputElement>('rotation-boxes');
const rotationTimeInput = mustGet<HTMLInputElement>('rotation-time');
const autoLiveInput = mustGet<HTMLInputElement>('auto-live');
const urlDialog = mustGet<HTMLDialogElement>('url-dialog');
const sharedUrlInput = mustGet<HTMLInputElement>('shared-url');
const zoomOutButton = mustGet<HTMLButtonElement>('zoom-out');
const zoomInButton = mustGet<HTMLButtonElement>('zoom-in');
const zoomStatusButton = mustGet<HTMLButtonElement>('zoom-status');
const updateToast = mustGet<HTMLElement>('update-toast');
const updateText = mustGet<HTMLElement>('update-text');
const updateProgress = mustGet<HTMLProgressElement>('update-progress');
const updateDismissButton = mustGet<HTMLButtonElement>('update-dismiss-btn');
const updateDownloadButton = mustGet<HTMLButtonElement>('update-download-btn');
const updateRestartButton = mustGet<HTMLButtonElement>('update-restart-btn');

const settings: GallerySettings = {
    audioLevels: true,
    muteRotation: false,
    rotationBoxes: '',
    rotationTime: 5,
    autoLive: true,
};

function mustGet<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing #${id}`);
    }
    return element as T;
}

function setZoomStatus(percent: number): void {
    zoomStatusButton.textContent = `${percent}%`;
    zoomOutButton.disabled = percent <= 20;
    zoomInButton.disabled = percent >= 300;
}

function initZoomControls(): void {
    window.liveGallery.getZoom().then(setZoomStatus).catch(console.error);
    window.liveGallery.onZoomChanged(setZoomStatus);

    zoomOutButton.addEventListener('click', () => {
        window.liveGallery.changeZoom(-1).then(setZoomStatus).catch(console.error);
    });
    zoomInButton.addEventListener('click', () => {
        window.liveGallery.changeZoom(1).then(setZoomStatus).catch(console.error);
    });
    zoomStatusButton.addEventListener('click', () => {
        window.liveGallery.setZoom(100).then(setZoomStatus).catch(console.error);
    });
}

function initUpdateControls(): void {
    window.liveGallery.onUpdateAvailable(() => {
        updateToast.classList.remove('hidden');
        updateText.textContent = 'A new version is ready to download.';
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
        updateText.textContent = `Downloading: ${progress.toFixed(1)}%`;
        updateDownloadButton.classList.add('hidden');
        updateDismissButton.classList.add('hidden');
        updateRestartButton.classList.add('hidden');
    });

    window.liveGallery.onUpdateReady(() => {
        updateToast.classList.remove('hidden');
        updateText.textContent = 'Update downloaded. Restart to install it.';
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
}

function syncControlsFromSettings(): void {
    muteRotationInput.checked = settings.muteRotation;
    rotationBoxesInput.value = settings.rotationBoxes;
    rotationTimeInput.value = String(settings.rotationTime);
    autoLiveInput.checked = settings.autoLive;
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
        'bg-base-200 border-base-300 relative m-1 h-fit w-[279px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border';
    root.innerHTML = `
        <div class="group bg-base-300 relative flex h-5 w-full items-center overflow-hidden">
          <button class="drag-handle btn btn-ghost btn-xs box-tool-btn relative z-20 cursor-grab" title="Drag">☰</button>
          <span class="box-number badge badge-sm badge-neutral absolute top-0 left-1 z-20 h-5 min-h-0"></span>
          <strong class="box-title bg-base-300 pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8 text-center text-sm font-semibold whitespace-nowrap group-hover:hidden group-focus-within:hidden"></strong>
          <button class="expand btn btn-secondary btn-xs btn-soft box-tool-btn box-tool-btn-first" title="Expand">🖥️</button>
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
            <option value="YN">YouTube Private</option>
            <option value="JW">JW Player</option>
            <option value="VC">VdoCipher</option>
            <option value="SS">Screen Share</option>
            <option value="CU">Custom URL</option>
          </select>
          <div class="value-slot"></div>
          <div class="mt-1 flex justify-center gap-2">
            <button type="button" class="cancel btn btn-xs min-w-16">Cancel</button>
            <button type="submit" class="btn btn-secondary btn-xs min-w-16">Save</button>
          </div>
        </form>
        <div class="viewport relative h-37.5 overflow-hidden bg-black">
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
            drawMeter(canvas, event.args[0] as LevelPayload);
        } else if (event.channel === 'gallery-error') {
            console.warn(`Box ${box.name || box.id} player error:`, event.args[0]);
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
    root.querySelector<HTMLButtonElement>('.solo')!.addEventListener('click', () =>
        soloBox(box.id),
    );
    root.querySelector<HTMLButtonElement>('.cancel')!.addEventListener('click', () =>
        setEditing(form, false),
    );
    muteButton.addEventListener('click', () => toggleMute(box.id));
    (form.elements.namedItem('type') as HTMLSelectElement).addEventListener('change', () => {
        const type = (form.elements.namedItem('type') as HTMLSelectElement).value as BoxType;
        setValueField(form, type, '');
        if (type === 'SS' && mics.length === 0) {
            loadMics().then(() => {
                if ((form.elements.namedItem('type') as HTMLSelectElement).value === 'SS') {
                    setValueField(form, type, '');
                }
            });
        }
    });

    root.addEventListener('dragstart', () => {
        draggedId = box.id;
    });
    root.addEventListener('dragover', (event) => event.preventDefault());
    root.addEventListener('drop', () => moveBox(draggedId, box.id));

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        box.name = String(formData.get('name') ?? '');
        box.type = String(formData.get('type') ?? 'YT') as BoxType;
        box.value =
            box.type === 'YT' || box.type === 'YN'
                ? extractYouTubeId(String(formData.get('value') ?? ''))
                : String(formData.get('value') ?? '');
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
    entry.title.textContent = box.name || box.type;
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
    form.querySelector<HTMLElement>('.value-slot')!.innerHTML =
        type === 'SS'
            ? `<select name="value" class="select select-xs">
                <option value="">Display audio / default</option>
                ${mics
                    .map(
                        (mic) =>
                            `<option value="${mic.deviceId}" ${value === mic.deviceId ? 'selected' : ''}>${mic.label}</option>`,
                    )
                    .join('')}
              </select>`
            : `<input name="value" class="input input-xs" type="text" placeholder="URL, ID, or microphone device" value="${value}" />`;
}

async function loadMics(): Promise<void> {
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
            if (entry.webviewReady) {
                entry.webview.reloadIgnoringCache();
            }
        }
        return;
    }

    entry.webviewReady = false;
    entry.pendingCommands = [];
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

function removeBox(boxId: string): void {
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index >= 0) {
        const [removed] = boxes.splice(index, 1);
        elements.get(removed.id)?.root.remove();
        elements.delete(removed.id);

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
    boxes.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, source);
    const sourceRoot = elements.get(sourceId)!.root;
    const targetRoot = elements.get(targetId)!.root;
    gallery.insertBefore(sourceRoot, targetRoot);
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
    rotationTimer = window.setInterval(
        () => {
            const selected = getRotationBoxes();
            if (selected.length === 0) {
                return;
            }
            soloBox(selected[index % selected.length].id);
            index += 1;
        },
        Math.max(1, settings.rotationTime) * 1000,
    );
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
    boxes.forEach((box) => {
        sendCommand(box.id, { type: 'auto-live', enabled: settings.autoLive });
    });
    saveState();
    restartRotation();
}

function makeShareUrl(): string {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('boxes', serializeBoxes(boxes));
    return url.toString();
}

document.getElementById('add-box')!.addEventListener('click', () => {
    addBox();
});

document.getElementById('copy-url')!.addEventListener('click', () => {
    navigator.clipboard.writeText(makeShareUrl()).catch(() => {
        sharedUrlInput.value = makeShareUrl();
        urlDialog.showModal();
    });
});

document.getElementById('import-url')!.addEventListener('click', () => {
    sharedUrlInput.value = '';
    urlDialog.showModal();
});

document.getElementById('load-shared-url')!.addEventListener('click', () => {
    const value = sharedUrlInput.value.trim();
    const sheetBoxes = parseSheetRows(value);
    if (sheetBoxes.length > 0) {
        boxes.splice(0, boxes.length, ...sheetBoxes);
    } else {
        const parsedUrl = new URL(value);
        boxes.splice(0, boxes.length, ...deserializeBoxes(parsedUrl.searchParams.get('boxes')));
    }
    render();
});

document.getElementById('lowest-quality')!.addEventListener('click', () => {
    boxes.forEach((box) => sendCommand(box.id, { type: 'lowest-quality' }));
});

[muteRotationInput, rotationBoxesInput, rotationTimeInput, autoLiveInput].forEach((input) => {
    input.addEventListener('change', updateAllSettings);
});
rotationBoxesInput.addEventListener('input', sanitizeRotationBoxesInput);

initZoomControls();
initUpdateControls();
loadState();
render();
