export type BoxType = 'YT' | 'JW' | 'VC' | 'SS' | 'CU' | 'LF';

export type GalleryBox = {
    id: string;
    name: string;
    type: BoxType;
    value: string;
    muted: boolean;
};

export type GallerySettings = {
    audioLevels: boolean;
    monoOutput: boolean;
    boxZoom: number;
    fitLayout: boolean;
    uiZoom: number;
    muteRotation: boolean;
    rotationBoxes: string;
    rotationTime: number;
    autoLive: boolean;
    jwServerHost: string;
    alertSound: boolean;
    alertVolume: number;
    alertVideoBuffering: boolean;
    alertVideoRepeatedBuffering: boolean;
    alertVideoFrozen: boolean;
    alertAudioSilent: boolean;
    alertAudioDropouts: boolean;
    alertAudioClipping: boolean;
    alertAudioChannelMissing: boolean;
    alertAudioImbalance: boolean;
    alertAudioPhaseMismatch: boolean;
};

const separator = '|';
const youtubeEmbedOrigin = 'https://live-gallery.local';
const youtubeIdPattern = /^[a-zA-Z0-9_-]{11}$/;

export function createId(): string {
    return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function extractYouTubeId(input: string): string {
    const trimmed = input.trim();
    try {
        const url = new URL(trimmed);
        const videoParam = url.searchParams.get('v');
        if (videoParam && youtubeIdPattern.test(videoParam)) {
            return videoParam;
        }

        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        const isYouTubeHost =
            hostname === 'youtube.com' ||
            hostname.endsWith('.youtube.com') ||
            hostname === 'youtube-nocookie.com' ||
            hostname.endsWith('.youtube-nocookie.com');
        const pathId = url.pathname
            .split('/')
            .filter(Boolean)
            .find((segment, index, segments) => {
                if (hostname === 'youtu.be') {
                    return index === 0 && youtubeIdPattern.test(segment);
                }

                return (
                    isYouTubeHost &&
                    ['embed', 'live', 'shorts', 'v'].includes(segments[index - 1] ?? '') &&
                    youtubeIdPattern.test(segment)
                );
            });

        if (pathId) {
            return pathId;
        }
    } catch {
        return trimmed;
    }

    return trimmed;
}

// What a pasted line is, if it can be a box: a YouTube link, an HLS stream or any other
// web address, or a local file URL.
export function detectSource(input: string): { type: BoxType; value: string } | null {
    const text = input.trim();
    if (!text) {
        return null;
    }

    if (text.startsWith('file://')) {
        return { type: 'LF', value: text };
    }

    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }

    if (youtubeIdPattern.test(extractYouTubeId(text))) {
        return { type: 'YT', value: extractYouTubeId(text) };
    }

    return { type: 'CU', value: text };
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
    params.set('audioPhaseMetrics', settings.alertAudioPhaseMismatch ? '1' : '0');
    params.set('monoOutput', settings.monoOutput ? '1' : '0');
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

    if (box.type === 'LF') {
        return new URL(
            `local-file-player.html?${params.toString()}`,
            window.location.href,
        ).toString();
    }

    if (box.type === 'YT') {
        params.set('origin', youtubeEmbedOrigin);
        params.set('playsinline', '1');
        params.set('widget_referrer', youtubeEmbedOrigin);
        return `https://www.youtube.com/embed/${extractYouTubeId(box.value)}?autoplay=1&enablejsapi=1&iv_load_policy=3&${params.toString()}`;
    }

    if (box.type === 'JW') {
        const url = `${normalizeJwServerHost(settings.jwServerHost)}${box.value}`;
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}viewUnpublished=True&${params.toString()}`;
    }

    if (box.type === 'VC') {
        return `https://player.vdocipher.com/live?liveId=${box.value}&preview=true&autoplay=1&${params.toString()}`;
    }

    return box.value;
}

// The same URL the box loads, minus the gallery's own parameters. YouTube boxes copy
// the watch link instead: embed URLs only play when the request carries a referrer
// (the app adds one), so opened directly in a browser they fail with Error 153.
// Boxes that play through one of the app's built-in player pages copy their media URL,
// and screen shares have no URL.
export function getSourceUrl(box: GalleryBox, settings: GallerySettings): string {
    const playerUrl = getPlayerUrl(box, settings);
    if (!playerUrl || box.type === 'SS') {
        return '';
    }

    if (box.type === 'YT') {
        return `https://www.youtube.com/watch?v=${extractYouTubeId(box.value)}`;
    }

    if (playerUrl === box.value) {
        return playerUrl;
    }

    const appDirectory = new URL('.', window.location.href).href;
    if (playerUrl.startsWith(appDirectory)) {
        return box.value.trim();
    }

    const url = new URL(playerUrl);
    const internalParams = [...settingsToParams(settings).keys(), 'boxId', 'value'];
    internalParams.forEach((name) => url.searchParams.delete(name));
    return url.toString();
}

function normalizeJwServerHost(value: string): string {
    const host = value.trim() || 'https://your.website.com/Player/Index/';
    return host.endsWith('/') ? host : `${host}/`;
}

function normalizeType(value: string): BoxType {
    const allowed = new Set(['YT', 'JW', 'VC', 'SS', 'CU', 'LF']);
    return allowed.has(value) ? (value as BoxType) : 'YT';
}
