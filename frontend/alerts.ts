import { GalleryBox, GallerySettings } from './utils.js';
import { icon } from './icons.js';

export type LevelPayload = {
    boxId: string;
    left: number;
    right: number;
    correlation?: number | null;
    monoLossDb?: number | null;
};

export type AlertKind =
    | 'video-buffering'
    | 'video-repeated-buffering'
    | 'video-frozen'
    | 'audio-silent'
    | 'audio-dropouts'
    | 'audio-clipping'
    | 'audio-channel-missing'
    | 'audio-imbalance'
    | 'audio-phase-mismatch';

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
    // Acknowledged alerts stop beeping but keep the box red until they clear.
    acknowledged?: boolean;
};

type AudioHealthState = {
    hasSignal: boolean;
    silentSince: number;
    lastNotSilentAt: number;
    channelMissingSince: number;
    imbalanceSince: number;
    phaseSamples: { bad: boolean; correlation: number; monoLossDb: number }[];
    phaseBadCount: number;
    phaseCorrelationSum: number;
    phaseMonoLossSum: number;
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
    alertsAckAllButton: HTMLButtonElement;
    getBoxTitle: (box: GalleryBox) => string;
    onShowBox: (boxId: string) => void;
    onChange?: (alerts: { boxId: string; kind: AlertKind }[]) => void;
};

export type AlertController = ReturnType<typeof createAlertController>;

const alertHistoryMs = 5 * 60 * 1000;
const alertMinimumActiveMs = 5000;
const alertBeepIntervalMs = 1000;
const alertBeepMaxActiveMs = 30 * 1000;
const alertBeepBaseGain = 0.27;
const audioSignalDb = -50;
const audioPhaseSignalDb = -75;
const audioSilentDb = -85;
const audioSilentAlertMs = 15000;
const audioSilentRecentSignalMs = 60 * 1000;
const audioChannelMissingAlertMs = 15000;
const audioImbalanceDb = 20;
const audioImbalanceAlertMs = 20000;
const audioPhaseMismatchCorrelation = -0.4;
const audioPhaseMismatchMonoLossDb = -5;
const audioPhaseMismatchAverageCorrelation = -0.35;
const audioPhaseMismatchBadRatio = 0.6;
const audioPhaseMismatchWindowRounds = 20;
const audioPhaseMismatchMinimumRounds = 20;
const audioDropoutWindowRounds = 10;
const audioDropoutCount = 3;
// Clipping means reaching digital full scale. Mastered music routinely peaks between
// -1 and 0 dBFS, so a lower threshold flags normal loud audio as clipping.
export const audioClippingDb = 0;
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
    alertsAckAllButton,
    getBoxTitle,
    onShowBox,
    onChange,
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
            phaseSamples: [],
            phaseBadCount: 0,
            phaseCorrelationSum: 0,
            phaseMonoLossSum: 0,
            clippingEvents: [],
            lastClippingNoticeAt: 0,
            dropoutSamples: [],
            wasSignal: false,
        };

        const isSignal = db > audioSignalDb;
        const isSilent = db < audioSilentDb;
        const leftSignal = payload.left > audioSignalDb;
        const rightSignal = payload.right > audioSignalDb;
        const leftPhaseSignal = payload.left > audioPhaseSignalDb;
        const rightPhaseSignal = payload.right > audioPhaseSignalDb;
        const leftSilent = payload.left < audioSilentDb;
        const rightSilent = payload.right < audioSilentDb;
        const oneChannelMissing = (leftSignal && rightSilent) || (rightSignal && leftSilent);
        const channelDifference = Math.abs(payload.left - payload.right);
        const isImbalanced =
            state.hasSignal && leftSignal && rightSignal && channelDifference >= audioImbalanceDb;
        const isPhaseMismatch =
            state.hasSignal &&
            leftPhaseSignal &&
            rightPhaseSignal &&
            payload.correlation !== null &&
            payload.correlation !== undefined &&
            payload.monoLossDb !== null &&
            payload.monoLossDb !== undefined &&
            payload.correlation <= audioPhaseMismatchCorrelation &&
            payload.monoLossDb <= audioPhaseMismatchMonoLossDb;
        const hasPhaseMetricsPayload =
            payload.correlation !== undefined || payload.monoLossDb !== undefined;

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

        if (hasPhaseMetricsPayload) {
            if (
                state.hasSignal &&
                leftPhaseSignal &&
                rightPhaseSignal &&
                payload.correlation !== null &&
                payload.correlation !== undefined &&
                payload.monoLossDb !== null &&
                payload.monoLossDb !== undefined
            ) {
                state.phaseSamples.push({
                    bad: isPhaseMismatch,
                    correlation: payload.correlation,
                    monoLossDb: payload.monoLossDb,
                });
                state.phaseBadCount += isPhaseMismatch ? 1 : 0;
                state.phaseCorrelationSum += payload.correlation;
                state.phaseMonoLossSum += payload.monoLossDb;

                const staleSample =
                    state.phaseSamples.length > audioPhaseMismatchWindowRounds
                        ? state.phaseSamples.shift()
                        : undefined;
                if (staleSample) {
                    state.phaseBadCount -= staleSample.bad ? 1 : 0;
                    state.phaseCorrelationSum -= staleSample.correlation;
                    state.phaseMonoLossSum -= staleSample.monoLossDb;
                }

                const badRatio = state.phaseBadCount / state.phaseSamples.length;
                const averageCorrelation = state.phaseCorrelationSum / state.phaseSamples.length;
                const averageMonoLossDb = state.phaseMonoLossSum / state.phaseSamples.length;

                setAlert(
                    payload.boxId,
                    'audio-phase-mismatch',
                    state.phaseSamples.length >= audioPhaseMismatchMinimumRounds &&
                        badRatio >= audioPhaseMismatchBadRatio &&
                        averageCorrelation <= audioPhaseMismatchAverageCorrelation &&
                        averageMonoLossDb <= audioPhaseMismatchMonoLossDb,
                );
            } else {
                resetPhaseSamples(state);
                setAlert(payload.boxId, 'audio-phase-mismatch', false);
            }
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

    function resetPhaseSamples(state: AudioHealthState): void {
        state.phaseSamples = [];
        state.phaseBadCount = 0;
        state.phaseCorrelationSum = 0;
        state.phaseMonoLossSum = 0;
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

        alertsCount.textContent = String(activeAlerts.length);
        alertsCount.classList.toggle('hidden', activeAlerts.length === 0);
        alertsButton.classList.toggle('is-alert', activeAlerts.length > 0);
        alertsButton.classList.toggle('btn-muted', activeAlerts.length === 0);
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
            entry.alertToggleButton.setAttribute('aria-label', 'Hide alerts for this box');
            entry.alertToggleButton.setAttribute('aria-pressed', String(isHidden));
            entry.alertOverlay.replaceChildren();
            entry.alertOverlay.classList.toggle('hidden', !hasActiveBoxAlerts || isHidden);

            if (!hasActiveBoxAlerts || isHidden) {
                return;
            }

            // Several alerts share one banner line so the picture stays visible.
            const banner = document.createElement('div');
            banner.className = 'alert-banner';
            banner.textContent = boxAlerts
                .map((alert) => alert.message + (alert.acknowledged ? ' (acknowledged)' : ''))
                .join(' · ');
            banner.title = banner.textContent;
            entry.alertOverlay.appendChild(banner);
        });

        onChange?.(activeAlerts.map(({ boxId, kind }) => ({ boxId, kind })));
        renderList();
    }

    // The list shows how long each alert has lasted, so it is redrawn every second while
    // the Alerts panel is open, without touching the beep or the boxes.
    function renderList(): void {
        const now = Date.now();
        const visibleAlerts = Array.from(alerts.values()).sort((a, b) => {
            if (a.active !== b.active) {
                return a.active ? -1 : 1;
            }
            return b.lastSeenAt - a.lastSeenAt;
        });
        const unacknowledged = visibleAlerts.filter((alert) => alert.active && !alert.acknowledged);
        alertsAckAllButton.classList.toggle('hidden', unacknowledged.length < 2);

        alertsList.replaceChildren();
        if (visibleAlerts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-label-2 px-4 py-6 text-center';
            empty.textContent = 'No alerts in the last five minutes';
            alertsList.appendChild(empty);
            return;
        }

        visibleAlerts.forEach((alert) => {
            const box = boxes.find((item) => item.id === alert.boxId);
            const number = box ? boxes.indexOf(box) + 1 : '?';
            const row = document.createElement('div');
            row.className = 'alert-row';

            const badge = document.createElement('span');
            badge.className = alert.active ? 'pill pill-danger' : 'pill';
            badge.textContent = !alert.active
                ? 'Resolved'
                : alert.acknowledged
                  ? 'Acknowledged'
                  : 'Active';

            const duration = formatDuration((alert.resolvedAt ?? now) - alert.activeSince);
            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'alert-row-main';
            main.title = box ? `Show box ${number}` : '';
            main.disabled = !box;
            main.innerHTML = `<span class="block font-medium">${escapeHtml(alert.message)}</span>
                <span class="text-label-2 block truncate text-xs">Box ${number} &middot; ${escapeHtml(box ? getBoxTitle(box) : alert.boxId)} &middot; ${alert.active ? 'for' : 'lasted'} ${duration}</span>`;
            main.addEventListener('click', () => onShowBox(alert.boxId));

            const time = document.createElement('time');
            time.className = 'text-label-2 text-xs whitespace-nowrap tabular-nums';
            time.dateTime = new Date(alert.activeSince).toISOString();
            time.title = 'Started at';
            time.textContent = new Date(alert.activeSince).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });

            row.append(badge, main, time);
            if (alert.active && !alert.acknowledged) {
                const ack = document.createElement('button');
                ack.type = 'button';
                ack.className = 'btn btn-sm btn-gray';
                ack.textContent = 'Acknowledge';
                ack.title = 'Stop the beep for this alert; the box stays red until it clears';
                ack.addEventListener('click', () => acknowledge([alert]));
                row.append(ack);
            }
            alertsList.appendChild(row);
        });
    }

    function acknowledge(targets: AlertRecord[]): void {
        targets.forEach((alert) => {
            alert.acknowledged = true;
        });
        render();
    }

    function acknowledgeAll(): void {
        acknowledge(Array.from(alerts.values()).filter((alert) => alert.active));
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
            'audio-phase-mismatch': settings.alertAudioPhaseMismatch,
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
            (alert) =>
                alert.active &&
                !alert.acknowledged &&
                now - alert.activeSince <= alertBeepMaxActiveMs,
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
        acknowledgeAll,
        clearBox,
        clearDisabled,
        render,
        renderList,
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
        'audio-phase-mismatch': 'Audio phase mismatch',
    };
    return messages[kind];
}

// 34s, 2m 05s, 1h 02m.
export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
