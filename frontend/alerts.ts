import { GalleryBox, GallerySettings } from './utils.js';

export type LevelPayload = {
    boxId: string;
    left: number;
    right: number;
};

export type AlertKind =
    | 'video-buffering'
    | 'video-repeated-buffering'
    | 'video-frozen'
    | 'audio-silent'
    | 'audio-dropouts'
    | 'audio-clipping'
    | 'audio-channel-missing'
    | 'audio-imbalance';

export type HealthPayload = {
    boxId: string;
    kind: AlertKind;
    active: boolean;
};

type AlertRecord = {
    boxId: string;
    kind: AlertKind;
    message: string;
    active: boolean;
    firstSeenAt: number;
    lastSeenAt: number;
    resolvedAt?: number;
};

type AudioHealthState = {
    hasSignal: boolean;
    silentSince: number;
    channelMissingSince: number;
    imbalanceSince: number;
    clippingSamples: number[];
    dropoutSamples: number[];
    wasSignal: boolean;
};

type BoxEntry = {
    root: HTMLElement;
};

type AlertControllerOptions = {
    settings: GallerySettings;
    boxes: GalleryBox[];
    elements: Map<string, BoxEntry>;
    alertsButton: HTMLButtonElement;
    alertsCount: HTMLElement;
    alertsList: HTMLElement;
    getBoxTitle: (box: GalleryBox) => string;
};

export type AlertController = ReturnType<typeof createAlertController>;

const alertHistoryMs = 5 * 60 * 1000;
const alertBeepIntervalMs = 5000;
const audioSignalDb = -50;
const audioSilentDb = -85;
const audioSilentAlertMs = 15000;
const audioChannelMissingAlertMs = 15000;
const audioImbalanceDb = 20;
const audioImbalanceAlertMs = 20000;
const audioDropoutWindowMs = 30000;
const audioDropoutCount = 5;
const audioClippingDb = -1;
const audioClippingWindowMs = 10000;
const audioClippingCount = 10;

export function createAlertController({
    settings,
    boxes,
    elements,
    alertsButton,
    alertsCount,
    alertsList,
    getBoxTitle,
}: AlertControllerOptions) {
    const alerts = new Map<string, AlertRecord>();
    const audioHealth = new Map<string, AudioHealthState>();
    let alertBeepTimer = 0;

    function updateFromHealth(payload: HealthPayload): void {
        setAlert(payload.boxId, payload.kind, payload.active);
    }

    function updateAudioHealth(payload: LevelPayload): void {
        const db = Math.max(payload.left, payload.right);
        const now = Date.now();
        const state = audioHealth.get(payload.boxId) ?? {
            hasSignal: false,
            silentSince: 0,
            channelMissingSince: 0,
            imbalanceSince: 0,
            clippingSamples: [],
            dropoutSamples: [],
            wasSignal: false,
        };

        const isSignal = db > audioSignalDb;
        const isSilent = db < audioSilentDb;
        const leftSignal = payload.left > audioSignalDb;
        const rightSignal = payload.right > audioSignalDb;
        const leftSilent = payload.left < audioSilentDb;
        const rightSilent = payload.right < audioSilentDb;
        const oneChannelMissing = (leftSignal && rightSilent) || (rightSignal && leftSilent);
        const channelDifference = Math.abs(payload.left - payload.right);
        const isImbalanced =
            state.hasSignal && leftSignal && rightSignal && channelDifference >= audioImbalanceDb;

        if (isSignal) {
            state.hasSignal = true;
            state.silentSince = 0;
            setAlert(payload.boxId, 'audio-silent', false);
        } else if (state.hasSignal && isSilent) {
            state.silentSince ||= now;
            setAlert(payload.boxId, 'audio-silent', now - state.silentSince >= audioSilentAlertMs);
        } else {
            state.silentSince = 0;
            setAlert(payload.boxId, 'audio-silent', false);
        }

        if (state.hasSignal && oneChannelMissing) {
            state.channelMissingSince ||= now;
            setAlert(
                payload.boxId,
                'audio-channel-missing',
                now - state.channelMissingSince >= audioChannelMissingAlertMs,
            );
        } else {
            state.channelMissingSince = 0;
            setAlert(payload.boxId, 'audio-channel-missing', false);
        }

        if (isImbalanced) {
            state.imbalanceSince ||= now;
            setAlert(
                payload.boxId,
                'audio-imbalance',
                now - state.imbalanceSince >= audioImbalanceAlertMs,
            );
        } else {
            state.imbalanceSince = 0;
            setAlert(payload.boxId, 'audio-imbalance', false);
        }

        if (state.hasSignal && state.wasSignal && isSilent) {
            state.dropoutSamples.push(now);
        }
        state.dropoutSamples = state.dropoutSamples.filter(
            (time) => now - time <= audioDropoutWindowMs,
        );
        setAlert(payload.boxId, 'audio-dropouts', state.dropoutSamples.length >= audioDropoutCount);

        if (db >= audioClippingDb) {
            state.clippingSamples.push(now);
        }
        state.clippingSamples = state.clippingSamples.filter(
            (time) => now - time <= audioClippingWindowMs,
        );
        setAlert(
            payload.boxId,
            'audio-clipping',
            state.clippingSamples.length >= audioClippingCount,
        );

        state.wasSignal = isSignal;
        audioHealth.set(payload.boxId, state);
    }

    function clearBox(boxId: string): void {
        Array.from(alerts.keys())
            .filter((key) => key.startsWith(`${boxId}:`))
            .forEach((key) => alerts.delete(key));
        audioHealth.delete(boxId);
        render();
    }

    function resetAll(): void {
        alerts.clear();
        audioHealth.clear();
        render();
    }

    function clearDisabled(): void {
        Array.from(alerts.values()).forEach((alert) => {
            if (!isAlertEnabled(alert.kind)) {
                setAlert(alert.boxId, alert.kind, false);
            }
        });
    }

    function render(): void {
        pruneAlerts();
        const activeAlerts = Array.from(alerts.values()).filter((alert) => alert.active);
        const visibleAlerts = Array.from(alerts.values()).sort((a, b) => {
            if (a.active !== b.active) {
                return a.active ? -1 : 1;
            }
            return b.lastSeenAt - a.lastSeenAt;
        });

        alertsCount.textContent = String(activeAlerts.length);
        alertsCount.classList.toggle('hidden', activeAlerts.length === 0);
        alertsButton.classList.toggle('btn-error', activeAlerts.length > 0);
        alertsButton.classList.toggle('btn-secondary', activeAlerts.length === 0);
        syncAlertBeepLoop(activeAlerts.length > 0);

        elements.forEach((entry, boxId) => {
            entry.root.classList.toggle(
                'box-alert',
                activeAlerts.some((alert) => alert.boxId === boxId),
            );
        });

        alertsList.replaceChildren();
        if (visibleAlerts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-base-content/60 rounded-md border border-base-content/15 p-3';
            empty.textContent = 'No active alerts';
            alertsList.appendChild(empty);
            return;
        }

        visibleAlerts.forEach((alert) => {
            const box = boxes.find((item) => item.id === alert.boxId);
            const number = box ? boxes.indexOf(box) + 1 : '?';
            const row = document.createElement('div');
            row.className =
                'border-base-content/15 bg-base-200 grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border p-2';

            const badge = document.createElement('span');
            badge.className = alert.active ? 'badge badge-error' : 'badge badge-ghost';
            badge.textContent = alert.active ? 'Active' : 'Resolved';

            const text = document.createElement('div');
            text.className = 'min-w-0';
            text.innerHTML = `<div class="font-semibold">${escapeHtml(alert.message)}</div>
                <div class="text-base-content/60 truncate">Box ${number} &middot; ${escapeHtml(box ? getBoxTitle(box) : alert.boxId)}</div>`;

            const time = document.createElement('time');
            time.className = 'text-base-content/60 text-xs whitespace-nowrap';
            time.dateTime = new Date(alert.lastSeenAt).toISOString();
            time.textContent = new Date(alert.lastSeenAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });

            row.append(badge, text, time);
            alertsList.appendChild(row);
        });
    }

    function setAlert(boxId: string, kind: AlertKind, active: boolean): void {
        if (!isAlertEnabled(kind)) {
            active = false;
        }

        const key = alertKey(boxId, kind);
        const existing = alerts.get(key);
        const now = Date.now();
        let changed = false;

        if (active) {
            if (existing?.active) {
                existing.lastSeenAt = now;
            } else {
                alerts.set(key, {
                    boxId,
                    kind,
                    message: getAlertMessage(kind),
                    active: true,
                    firstSeenAt: existing?.firstSeenAt ?? now,
                    lastSeenAt: now,
                });
                changed = true;
            }
        } else if (existing?.active) {
            existing.active = false;
            existing.lastSeenAt = now;
            existing.resolvedAt = now;
            changed = true;
        } else if (!existing) {
            return;
        }

        pruneAlerts();
        if (changed) {
            render();
        }
    }

    function isAlertEnabled(kind: AlertKind): boolean {
        const enabled: Record<AlertKind, boolean> = {
            'video-buffering': settings.alertVideoBuffering,
            'video-repeated-buffering': settings.alertVideoRepeatedBuffering,
            'video-frozen': settings.alertVideoFrozen,
            'audio-silent': settings.alertAudioSilent,
            'audio-dropouts': settings.alertAudioDropouts,
            'audio-clipping': settings.alertAudioClipping,
            'audio-channel-missing': settings.alertAudioChannelMissing,
            'audio-imbalance': settings.alertAudioImbalance,
        };
        return enabled[kind];
    }

    function syncAlertBeepLoop(hasActiveAlerts: boolean): void {
        window.clearInterval(alertBeepTimer);
        alertBeepTimer = 0;

        if (!hasActiveAlerts || !settings.alertSound) {
            return;
        }

        beepForAlert();
        alertBeepTimer = window.setInterval(beepForAlert, alertBeepIntervalMs);
    }

    function beepForAlert(): void {
        if (!settings.alertSound) {
            return;
        }

        const AudioContextClass =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.25);
        window.setTimeout(() => context.close().catch(() => {}), 500);
    }

    function pruneAlerts(): void {
        const now = Date.now();
        alerts.forEach((alert, key) => {
            if (!alert.active && alert.resolvedAt && now - alert.resolvedAt > alertHistoryMs) {
                alerts.delete(key);
            }
        });
    }

    return {
        clearBox,
        clearDisabled,
        render,
        resetAll,
        updateAudioHealth,
        updateFromHealth,
    };
}

function alertKey(boxId: string, kind: AlertKind): string {
    return `${boxId}:${kind}`;
}

function getAlertMessage(kind: AlertKind): string {
    const messages: Record<AlertKind, string> = {
        'video-buffering': 'Video buffering',
        'video-repeated-buffering': 'Repeated buffering',
        'video-frozen': 'Video frozen',
        'audio-silent': 'Audio silent',
        'audio-dropouts': 'Audio dropouts',
        'audio-clipping': 'Audio clipping',
        'audio-channel-missing': 'Audio one channel missing',
        'audio-imbalance': 'Audio imbalance',
    };
    return messages[kind];
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
