import { GalleryBox, GallerySettings } from './utils.js';
import { icon } from './icons.js';

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
    activeSince: number;
    firstSeenAt: number;
    lastSeenAt: number;
    resolvedAt?: number;
};

type AudioHealthState = {
    hasSignal: boolean;
    silentSince: number;
    lastNotSilentAt: number;
    channelMissingSince: number;
    imbalanceSince: number;
    clippingEvents: number[];
    lastClippingNoticeAt: number;
    dropoutSamples: boolean[];
    wasSignal: boolean;
};

type BoxEntry = {
    root: HTMLElement;
    alertToggleButton: HTMLButtonElement;
    alertOverlay: HTMLElement;
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
const alertMinimumActiveMs = 5000;
const alertBeepIntervalMs = 1000;
const alertBeepMaxActiveMs = 30 * 1000;
const alertBeepBaseGain = 0.27;
const audioSignalDb = -50;
const audioSilentDb = -85;
const audioSilentAlertMs = 15000;
const audioSilentRecentSignalMs = 60 * 1000;
const audioChannelMissingAlertMs = 15000;
const audioImbalanceDb = 20;
const audioImbalanceAlertMs = 20000;
const audioDropoutWindowRounds = 10;
const audioDropoutCount = 3;
const audioClippingDb = -1;
const audioClippingWindowMs = 7000;
const audioClippingCooldownMs = 1000;
const audioClippingCount = 5;

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
    const hiddenBoxAlerts = new Set<string>();
    const alertResolveTimers = new Map<string, number>();
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
            lastNotSilentAt: 0,
            channelMissingSince: 0,
            imbalanceSince: 0,
            clippingEvents: [],
            lastClippingNoticeAt: 0,
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
            state.lastNotSilentAt = now;
            state.silentSince = 0;
            setAlert(payload.boxId, 'audio-silent', false);
        } else if (state.hasSignal && isSilent) {
            state.silentSince ||= now;
            setAlert(
                payload.boxId,
                'audio-silent',
                now - state.silentSince >= audioSilentAlertMs &&
                    now - state.lastNotSilentAt <= audioSilentRecentSignalMs,
            );
        } else {
            state.lastNotSilentAt = now;
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

        const isDropout = state.hasSignal && state.wasSignal && isSilent;
        state.dropoutSamples.push(isDropout);
        state.dropoutSamples = state.dropoutSamples.slice(-audioDropoutWindowRounds);
        setAlert(
            payload.boxId,
            'audio-dropouts',
            state.dropoutSamples.filter(Boolean).length >= audioDropoutCount,
        );

        const isClipping = db >= audioClippingDb;
        if (isClipping && now - state.lastClippingNoticeAt >= audioClippingCooldownMs) {
            state.clippingEvents.push(now);
            state.lastClippingNoticeAt = now;
        }
        state.clippingEvents = state.clippingEvents.filter(
            (time) => now - time <= audioClippingWindowMs,
        );
        setAlert(
            payload.boxId,
            'audio-clipping',
            state.clippingEvents.length >= audioClippingCount,
        );

        state.wasSignal = isSignal;
        audioHealth.set(payload.boxId, state);
    }

    function clearBox(boxId: string): void {
        Array.from(alerts.keys())
            .filter((key) => key.startsWith(`${boxId}:`))
            .forEach((key) => {
                clearAlertResolveTimer(key);
                alerts.delete(key);
            });
        audioHealth.delete(boxId);
        hiddenBoxAlerts.delete(boxId);
        render();
    }

    function resetAll(): void {
        alertResolveTimers.forEach((timer) => window.clearTimeout(timer));
        alertResolveTimers.clear();
        alerts.clear();
        audioHealth.clear();
        hiddenBoxAlerts.clear();
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
        alertsButton.classList.toggle('btn-accent', activeAlerts.length === 0);
        syncAlertBeepLoop(activeAlerts);

        elements.forEach((entry, boxId) => {
            const boxAlerts = activeAlerts.filter((alert) => alert.boxId === boxId);
            const hasActiveBoxAlerts = boxAlerts.length > 0;
            const isHidden = hiddenBoxAlerts.has(boxId);
            const alertToggleLabel = isHidden
                ? 'Show alerts for this box'
                : 'Hide alerts for this box';

            entry.root.classList.toggle('box-alert', hasActiveBoxAlerts);
            entry.alertToggleButton.innerHTML = icon(isHidden ? 'eye-off' : 'eye');
            entry.alertToggleButton.title = alertToggleLabel;
            entry.alertToggleButton.setAttribute('aria-label', alertToggleLabel);
            entry.alertOverlay.replaceChildren();
            entry.alertOverlay.classList.toggle('hidden', !hasActiveBoxAlerts || isHidden);
            entry.alertOverlay.classList.toggle('grid', hasActiveBoxAlerts && !isHidden);

            if (!hasActiveBoxAlerts || isHidden) {
                return;
            }

            const stack = document.createElement('div');
            stack.className = 'grid max-w-[calc(100%-1rem)] gap-1.5';
            boxAlerts.forEach((alert) => {
                const badge = document.createElement('div');
                badge.className =
                    'alert alert-error min-h-0 justify-center rounded-md border-error-content/20 px-3 py-1.5 text-center text-xs font-semibold shadow-lg shadow-black/50';
                badge.textContent = alert.message;
                stack.appendChild(badge);
            });
            entry.alertOverlay.appendChild(stack);
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
            clearAlertResolveTimer(key);
            if (existing?.active) {
                existing.lastSeenAt = now;
                existing.resolvedAt = undefined;
            } else {
                alerts.set(key, {
                    boxId,
                    kind,
                    message: getAlertMessage(kind),
                    active: true,
                    activeSince: now,
                    firstSeenAt: existing?.firstSeenAt ?? now,
                    lastSeenAt: now,
                });
                changed = true;
            }
        } else if (existing?.active) {
            const activeForMs = now - existing.activeSince;
            if (activeForMs < alertMinimumActiveMs) {
                scheduleAlertResolve(key, alertMinimumActiveMs - activeForMs);
            } else {
                resolveAlert(existing, now);
                clearAlertResolveTimer(key);
                changed = true;
            }
        } else if (!existing) {
            return;
        }

        pruneAlerts();
        if (changed) {
            render();
        }
    }

    function resolveAlert(alert: AlertRecord, now = Date.now()): void {
        alert.active = false;
        alert.lastSeenAt = now;
        alert.resolvedAt = now;
    }

    function scheduleAlertResolve(key: string, delayMs: number): void {
        if (alertResolveTimers.has(key)) {
            return;
        }

        const timer = window.setTimeout(() => {
            alertResolveTimers.delete(key);
            const alert = alerts.get(key);
            if (!alert?.active) {
                return;
            }

            resolveAlert(alert);
            render();
        }, delayMs);
        alertResolveTimers.set(key, timer);
    }

    function clearAlertResolveTimer(key: string): void {
        const timer = alertResolveTimers.get(key);
        if (timer === undefined) {
            return;
        }

        window.clearTimeout(timer);
        alertResolveTimers.delete(key);
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

    function syncAlertBeepLoop(activeAlerts: AlertRecord[]): void {
        window.clearInterval(alertBeepTimer);
        alertBeepTimer = 0;

        if (!settings.alertSound || settings.alertVolume <= 0 || !hasBeepableAlert(activeAlerts)) {
            return;
        }

        beepForAlert();
        alertBeepTimer = window.setInterval(beepForAlert, alertBeepIntervalMs);
    }

    function beepForAlert(): void {
        if (
            !settings.alertSound ||
            settings.alertVolume <= 0 ||
            !hasBeepableAlert(Array.from(alerts.values()))
        ) {
            window.clearInterval(alertBeepTimer);
            alertBeepTimer = 0;
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
        const volume = Math.max(0, Math.min(500, settings.alertVolume)) / 100;
        const peakGain = Math.max(0.0001, alertBeepBaseGain * volume);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(peakGain, context.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.24);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.25);
        window.setTimeout(() => context.close().catch(() => {}), 500);
    }

    function hasBeepableAlert(candidateAlerts: AlertRecord[]): boolean {
        const now = Date.now();
        return candidateAlerts.some(
            (alert) => alert.active && now - alert.activeSince <= alertBeepMaxActiveMs,
        );
    }

    function pruneAlerts(): void {
        const now = Date.now();
        alerts.forEach((alert, key) => {
            if (!alert.active && alert.resolvedAt && now - alert.resolvedAt > alertHistoryMs) {
                alerts.delete(key);
            }
        });
    }

    function toggleBoxAlerts(boxId: string): void {
        if (hiddenBoxAlerts.has(boxId)) {
            hiddenBoxAlerts.delete(boxId);
        } else {
            hiddenBoxAlerts.add(boxId);
        }
        render();
    }

    return {
        clearBox,
        clearDisabled,
        render,
        resetAll,
        toggleBoxAlerts,
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
