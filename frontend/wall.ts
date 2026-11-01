import type { AlertKind } from './alerts.js';

// The wall's rules, apart from the page: what each box's player is doing, which boxes
// rotation picks, who counts as solo, and what the header summarizes. Pure, so they run
// without a DOM.

// What a box's player is doing, apart from alerts. Only 'playing' counts as live: the
// guest preload reports it while playback time keeps moving.
export type BoxSignal = 'loading' | 'playing' | 'not-playing' | 'no-video' | 'failed';

export type SignalTracker = {
    get(boxId: string): BoxSignal | undefined;
    set(boxId: string, signal: BoxSignal | null): void;
    onPlayback(boxId: string, playing: boolean): void;
    clear(): void;
};

// Tracks each box's signal. A box that stays 'loading' for startTimeoutMs becomes
// 'not-playing' if it ever had media, else 'no-video'. onChange runs after every set.
export function createSignalTracker(options: {
    startTimeoutMs: number;
    schedule: (run: () => void, ms: number) => number;
    cancel: (handle: number) => void;
    onChange: (boxId: string, signal: BoxSignal | null) => void;
}): SignalTracker {
    const signals = new Map<string, BoxSignal>();
    const timers = new Map<string, number>();
    const withMedia = new Set<string>();

    const set = (boxId: string, signal: BoxSignal | null): void => {
        const timer = timers.get(boxId);
        if (timer !== undefined) {
            options.cancel(timer);
        }
        timers.delete(boxId);
        if (signal) {
            signals.set(boxId, signal);
        } else {
            signals.delete(boxId);
            withMedia.delete(boxId);
        }

        if (signal === 'loading') {
            withMedia.delete(boxId);
            timers.set(
                boxId,
                options.schedule(() => {
                    if (signals.get(boxId) === 'loading') {
                        set(boxId, withMedia.has(boxId) ? 'not-playing' : 'no-video');
                    }
                }, options.startTimeoutMs),
            );
        }

        options.onChange(boxId, signal);
    };

    return {
        get: (boxId) => signals.get(boxId),
        set,
        onPlayback(boxId, playing) {
            withMedia.add(boxId);
            if (playing) {
                set(boxId, 'playing');
            } else if (signals.get(boxId) !== 'loading') {
                // Until the start timeout, a player that has not started yet is still starting.
                set(boxId, 'not-playing');
            }
        },
        clear() {
            timers.forEach((timer) => options.cancel(timer));
            timers.clear();
            signals.clear();
            withMedia.clear();
        },
    };
}

// The header summarizes the wall: how many boxes are live and how many have each kind of
// problem.
export type StatusGroup = 'frozen' | 'buffering' | 'silent' | 'audio';

const statusGroupOf: Record<AlertKind, StatusGroup> = {
    'video-frozen': 'frozen',
    'video-buffering': 'buffering',
    'video-repeated-buffering': 'buffering',
    'audio-silent': 'silent',
    'audio-dropouts': 'audio',
    'audio-clipping': 'audio',
    'audio-channel-missing': 'audio',
    'audio-imbalance': 'audio',
    'audio-phase-mismatch': 'audio',
};

export type WallStatus = {
    live: number;
    empty: number;
    failed: string[];
    notPlaying: string[];
    loading: string[];
    // Box ids per alert group, in the order the alerts arrived.
    alerts: Map<StatusGroup, string[]>;
};

// An alerting box is counted under its alert only, never also as live or not playing.
export function summarizeWall(
    boxes: { id: string; configured: boolean }[],
    signalOf: (boxId: string) => BoxSignal | undefined,
    activeAlerts: { boxId: string; kind: AlertKind }[],
): WallStatus {
    const alerts = new Map<StatusGroup, string[]>();
    activeAlerts.forEach(({ boxId, kind }) => {
        const group = statusGroupOf[kind];
        const ids = alerts.get(group) ?? [];
        if (!ids.includes(boxId)) {
            ids.push(boxId);
        }
        alerts.set(group, ids);
    });

    const alertingIds = new Set(activeAlerts.map((alert) => alert.boxId));
    const configured = boxes.filter((box) => box.configured);
    const bySignal = (signals: BoxSignal[]): string[] =>
        configured
            .filter((box) => !alertingIds.has(box.id))
            .filter((box) => signals.includes(signalOf(box.id) ?? 'loading'))
            .map((box) => box.id);

    return {
        live: bySignal(['playing']).length,
        empty: boxes.length - configured.length,
        failed: bySignal(['failed']),
        notPlaying: bySignal(['not-playing', 'no-video']),
        loading: bySignal(['loading']),
        alerts,
    };
}

export function getRotationSyntaxError(value: string): string | null {
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        if (/^\d+$/.test(token)) {
            continue;
        }

        const range = token.match(/^(\d+)-(\d+)$/);
        if (!range) {
            return 'Use numbers or ranges like 2 4 9-11. Dashes need numbers on both sides.';
        }

        if (Number(range[2]) <= Number(range[1])) {
            return 'Range end must be greater than range start.';
        }
    }

    return null;
}

// The boxes rotation steps through, in the order typed ("2 4 9-11"); every box when the
// field is empty, none when it is malformed. Numbers beyond the wall are dropped.
export function selectRotationBoxes<T>(boxes: T[], spec: string): T[] {
    if (spec.trim() === '') {
        return boxes;
    }

    if (getRotationSyntaxError(spec)) {
        return [];
    }

    return spec
        .split(/\s+/)
        .flatMap((token) => {
            const match = token.match(/^(\d+)(?:-(\d+))?$/);
            if (!match) {
                return [];
            }

            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : start;
            const numbers: number[] = [];
            if (start > 0) {
                for (let current = start; current <= end; current += 1) {
                    numbers.push(current);
                }
            }
            return numbers;
        })
        .map((number) => boxes[number - 1])
        .filter((box): box is T => Boolean(box));
}

// Solo means exactly this box is unmuted.
export function isSolo(boxes: { id: string; muted: boolean }[], boxId: string): boolean {
    return (
        boxes.some((box) => box.id === boxId && !box.muted) &&
        boxes.every((box) => box.id === boxId || box.muted)
    );
}

// Which box shows as solo: one unmuted box on a wall of several.
export function soloBoxId(boxes: { id: string; muted: boolean }[]): string {
    const unmuted = boxes.filter((box) => !box.muted);
    return unmuted.length === 1 && boxes.length > 1 ? unmuted[0].id : '';
}
