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
    status: HTMLElement;
    form: HTMLFormElement;
    webview: Electron.WebviewTag;
    canvas: HTMLCanvasElement;
    muteButton: HTMLButtonElement;
};

const boxes: GalleryBox[] = [];
const elements = new Map<string, BoxElements>();
let rotationTimer = 0;
let draggedId = '';

const gallery = mustGet<HTMLElement>('gallery');
const template = mustGet<HTMLTemplateElement>('box-template');
const audioLevelsInput = mustGet<HTMLInputElement>('audio-levels');
const muteRotationInput = mustGet<HTMLInputElement>('mute-rotation');
const rotationBoxesInput = mustGet<HTMLInputElement>('rotation-boxes');
const rotationTimeInput = mustGet<HTMLInputElement>('rotation-time');
const autoLiveInput = mustGet<HTMLInputElement>('auto-live');
const urlDialog = mustGet<HTMLDialogElement>('url-dialog');
const sharedUrlInput = mustGet<HTMLInputElement>('shared-url');

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

function syncSettingsFromControls(): void {
    settings.audioLevels = audioLevelsInput.checked;
    settings.muteRotation = muteRotationInput.checked;
    settings.rotationBoxes = rotationBoxesInput.value;
    settings.rotationTime = Math.max(1, Number(rotationTimeInput.value) || 1);
    settings.autoLive = autoLiveInput.checked;
}

function syncControlsFromSettings(): void {
    audioLevelsInput.checked = settings.audioLevels;
    muteRotationInput.checked = settings.muteRotation;
    rotationBoxesInput.value = settings.rotationBoxes;
    rotationTimeInput.value = String(settings.rotationTime);
    autoLiveInput.checked = settings.autoLive;
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

function renderBox(box: GalleryBox, index: number): void {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const root = fragment.querySelector<HTMLElement>('.box')!;
    const title = fragment.querySelector<HTMLElement>('.box-title')!;
    const number = fragment.querySelector<HTMLElement>('.box-number')!;
    const status = fragment.querySelector<HTMLElement>('.box-status')!;
    const form = fragment.querySelector<HTMLFormElement>('.box-form')!;
    const webview = fragment.querySelector<Electron.WebviewTag>('webview')!;
    const canvas = fragment.querySelector<HTMLCanvasElement>('canvas')!;
    const muteButton = fragment.querySelector<HTMLButtonElement>('.mute')!;

    root.dataset.id = box.id;
    root.draggable = true;
    title.textContent = box.name || box.type;
    number.textContent = String(index + 1);
    muteButton.textContent = box.muted ? 'Muted' : 'Live';
    root.classList.toggle('unmuted', !box.muted);
    root.classList.toggle('editing', !box.value);

    form.elements.namedItem('name') &&
        ((form.elements.namedItem('name') as HTMLInputElement).value = box.name);
    form.elements.namedItem('type') &&
        ((form.elements.namedItem('type') as HTMLSelectElement).value = box.type);
    form.elements.namedItem('value') &&
        ((form.elements.namedItem('value') as HTMLInputElement).value = box.value);

    webview.setAttribute('preload', window.liveGallery.guestPreloadUrl);
    webview.setAttribute(
        'webpreferences',
        'contextIsolation=yes,nodeIntegration=no,webSecurity=no',
    );
    webview.addEventListener('ipc-message', (event) => {
        if (event.channel === 'gallery-level') {
            drawMeter(canvas, event.args[0] as LevelPayload);
        } else if (event.channel === 'gallery-error') {
            status.textContent = 'meter unavailable';
        }
    });
    webview.addEventListener('did-start-loading', () => {
        status.textContent = 'loading';
    });
    webview.addEventListener('did-finish-load', () => {
        status.textContent = box.muted ? 'muted' : 'live';
        sendCommand(box.id, { type: 'mute', muted: box.muted });
    });

    root.querySelector<HTMLButtonElement>('.expand')!.addEventListener('click', () => {
        root.classList.toggle('expanded');
    });
    root.querySelector<HTMLButtonElement>('.edit')!.addEventListener('click', () => {
        root.classList.add('editing');
    });
    root.querySelector<HTMLButtonElement>('.reload')!.addEventListener('click', () =>
        loadWebview(box),
    );
    root.querySelector<HTMLButtonElement>('.remove')!.addEventListener('click', () =>
        removeBox(box.id),
    );
    root.querySelector<HTMLButtonElement>('.solo')!.addEventListener('click', () =>
        soloBox(box.id),
    );
    root.querySelector<HTMLButtonElement>('.cancel')!.addEventListener('click', () =>
        root.classList.remove('editing'),
    );
    muteButton.addEventListener('click', () => toggleMute(box.id));

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
        root.classList.remove('editing');
        render();
    });

    gallery.appendChild(fragment);
    elements.set(box.id, { root, title, number, status, form, webview, canvas, muteButton });
    loadWebview(box);
}

function loadWebview(box: GalleryBox): void {
    const entry = elements.get(box.id);
    if (!entry) {
        return;
    }

    const src = getPlayerUrl(box, settings);
    entry.root.classList.toggle('loaded', Boolean(src));
    entry.webview.src = src || 'about:blank';
}

function sendCommand(boxId: string, command: Record<string, unknown>): void {
    const entry = elements.get(boxId);
    if (entry?.webview.isLoading() === false) {
        entry.webview.send('gallery-command', command);
    }
}

function toggleMute(boxId: string, forceMuted?: boolean): void {
    const box = boxes.find((item) => item.id === boxId);
    const entry = elements.get(boxId);
    if (!box || !entry) {
        return;
    }

    box.muted = forceMuted ?? !box.muted;
    entry.root.classList.toggle('unmuted', !box.muted);
    entry.muteButton.textContent = box.muted ? 'Muted' : 'Live';
    entry.status.textContent = box.muted ? 'muted' : 'live';
    sendCommand(box.id, { type: 'mute', muted: box.muted });
    saveState();
}

function soloBox(boxId: string): void {
    boxes.forEach((box) => toggleMute(box.id, box.id !== boxId));
}

function removeBox(boxId: string): void {
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index >= 0) {
        boxes.splice(index, 1);
        if (boxes.length === 0) {
            boxes.push(makeBox());
        }
        render();
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
    render();
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
        { min: -90, max: -36, color: '#218c45' },
        { min: -36, max: -18, color: '#35c76f' },
        { min: -18, max: -6, color: '#82e66f' },
        { min: -6, max: -1, color: '#f6d84a' },
        { min: -1, max: 0, color: '#f36f6f' },
    ];
    const width = context.canvas.width / 2;
    const height = context.canvas.height;
    const normalized = Math.max(0, Math.min(1, (db + 90) / 90));
    const filledHeight = normalized * height;
    let cursor = height;

    ranges.forEach((range) => {
        const rangeStart = Math.max(0, (range.min + 90) / 90) * height;
        const rangeEnd = Math.max(0, (range.max + 90) / 90) * height;
        const segmentHeight = Math.max(0, Math.min(filledHeight, rangeEnd) - rangeStart);
        if (segmentHeight > 0) {
            cursor -= segmentHeight;
            context.fillStyle = range.color;
            context.fillRect(x, cursor, width, segmentHeight);
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
    const numbers = settings.rotationBoxes
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);

    if (numbers.length === 0) {
        return boxes;
    }

    return numbers
        .map((number) => boxes[number - 1])
        .filter((box): box is GalleryBox => Boolean(box));
}

function updateAllSettings(): void {
    syncSettingsFromControls();
    boxes.forEach((box) => {
        sendCommand(box.id, { type: 'audio-levels', enabled: settings.audioLevels });
        sendCommand(box.id, { type: 'auto-live', enabled: settings.autoLive });
        loadWebview(box);
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
    boxes.push(makeBox());
    render();
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

[audioLevelsInput, muteRotationInput, rotationBoxesInput, rotationTimeInput, autoLiveInput].forEach(
    (input) => {
        input.addEventListener('change', updateAllSettings);
    },
);

loadState();
render();
