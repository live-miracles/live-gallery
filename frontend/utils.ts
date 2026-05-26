export type BoxType = 'YT' | 'JW' | 'VC' | 'SS' | 'FB' | 'CU';

export type GalleryBox = {
    id: string;
    name: string;
    type: BoxType;
    value: string;
    muted: boolean;
};

export type GallerySettings = {
    audioLevels: boolean;
    muteRotation: boolean;
    rotationBoxes: string;
    rotationTime: number;
    autoLive: boolean;
};

const separator = '|';
const youtubeEmbedOrigin = 'https://live-gallery.local';

export function createId(): string {
    return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function extractYouTubeId(input: string): string {
    try {
        const url = new URL(input.trim());
        const videoParam = url.searchParams.get('v');
        if (videoParam) {
            return videoParam;
        }
        if (url.hostname === 'youtu.be') {
            return url.pathname.slice(1);
        }
        if (url.pathname.startsWith('/live/')) {
            return url.pathname.slice('/live/'.length);
        }
    } catch {
        return input.trim();
    }

    return input.trim();
}

export function parseSheetRows(input: string): GalleryBox[] {
    return input
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const [first = '', second = ''] = line.split('\t');
            const left = extractYouTubeId(first);
            const right = extractYouTubeId(second);
            const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;

            if (youtubeIdPattern.test(right)) {
                return makeBox(left || String(index + 1), 'YT', right);
            }

            if (youtubeIdPattern.test(left)) {
                return makeBox(right || String(index + 1), 'YT', left);
            }

            return null;
        })
        .filter((box): box is GalleryBox => Boolean(box));
}

export function makeBox(name = '', type: BoxType = 'YT', value = ''): GalleryBox {
    return { id: createId(), name, type, value, muted: true };
}

export function serializeBoxes(boxes: GalleryBox[]): string {
    return boxes
        .map((box) =>
            [box.name, box.type, box.value]
                .map((part) => encodeURIComponent(part.split(separator).join('')))
                .join('.'),
        )
        .join(separator);
}

export function deserializeBoxes(value: string | null): GalleryBox[] {
    if (!value) {
        return [];
    }

    return value
        .split(separator)
        .filter(Boolean)
        .map((entry) => {
            const [name = '', type = 'YT', boxValue = ''] = entry.split('.');
            return makeBox(
                decodeURIComponent(name),
                normalizeType(decodeURIComponent(type)),
                decodeURIComponent(boxValue),
            );
        });
}

export function settingsToParams(settings: GallerySettings): URLSearchParams {
    const params = new URLSearchParams();
    params.set('audioLevels', settings.audioLevels ? '1' : '0');
    params.set('muteRotation', settings.muteRotation ? '1' : '0');
    params.set('rotationBoxes', settings.rotationBoxes);
    params.set('rotationTime', String(settings.rotationTime));
    params.set('autoLive', settings.autoLive ? '1' : '0');
    return params;
}

export function getPlayerUrl(box: GalleryBox, settings: GallerySettings): string {
    const params = settingsToParams(settings);
    params.set('boxId', box.id);
    params.set('value', box.value);

    if (box.type === 'SS') {
        return new URL(`screen-share.html?${params.toString()}`, window.location.href).toString();
    }

    if (!box.value.trim()) {
        return '';
    }

    if (box.type === 'CU') {
        if (box.value.endsWith('.m3u8')) {
            return new URL(
                `m3u8-player.html?${params.toString()}`,
                window.location.href,
            ).toString();
        }
        return box.value;
    }

    if (box.type === 'YT') {
        params.set('origin', youtubeEmbedOrigin);
        params.set('mute', '1');
        params.set('playsinline', '1');
        params.set('widget_referrer', youtubeEmbedOrigin);
        return `https://www.youtube.com/embed/${extractYouTubeId(box.value)}?autoplay=1&enablejsapi=1&iv_load_policy=3&${params.toString()}`;
    }

    if (box.type === 'JW') {
        return `https://player.controlhub.innerengineering.vualto.com/Player/Index/${box.value}?viewUnpublished=True&${params.toString()}`;
    }

    if (box.type === 'VC') {
        return `https://player.vdocipher.com/live?liveId=${box.value}&preview=true&autoplay=1&${params.toString()}`;
    }

    if (box.type === 'FB') {
        return `https://www.facebook.com/video/embed?video_id=${box.value}&${params.toString()}`;
    }

    return box.value;
}

function normalizeType(value: string): BoxType {
    const allowed = new Set(['YT', 'JW', 'VC', 'SS', 'FB', 'CU']);
    return allowed.has(value) ? (value as BoxType) : 'YT';
}
