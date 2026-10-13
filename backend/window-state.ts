import fs from 'node:fs';
import type { Display, Rectangle } from 'electron';

export type SavedDisplay = {
    id: number;
    label: string;
    bounds: Rectangle;
    workArea: Rectangle;
};

export type WindowState = {
    bounds: Rectangle;
    display: SavedDisplay;
    isMaximized: boolean;
    isFullScreen: boolean;
};

type DisplayLike = Pick<Display, 'id' | 'label' | 'bounds' | 'workArea'>;

export function readWindowState(file: string): WindowState | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        return isWindowState(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function writeWindowState(file: string, state: WindowState): void {
    try {
        fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch (error) {
        console.warn('Could not save window state:', error);
    }
}

export function toSavedDisplay(display: DisplayLike): SavedDisplay {
    return {
        id: display.id,
        label: display.label,
        bounds: display.bounds,
        workArea: display.workArea,
    };
}

// Display ids can change after a reboot or reconnecting a monitor, so the saved display
// is matched from the most to the least specific evidence: id and position, monitor
// name and position, then size, then any single clue.
export function findSavedDisplay<T extends DisplayLike>(
    saved: SavedDisplay,
    displays: T[],
): T | undefined {
    const sameId = (display: T): boolean => display.id === saved.id;
    const sameLabel = (display: T): boolean => saved.label !== '' && display.label === saved.label;
    const sameBounds = (display: T): boolean => rectsEqual(display.bounds, saved.bounds);
    const sameSize = (display: T): boolean =>
        display.bounds.width === saved.bounds.width &&
        display.bounds.height === saved.bounds.height;
    const checks = [
        (display: T) => sameId(display) && sameBounds(display),
        (display: T) => sameLabel(display) && sameBounds(display),
        (display: T) => sameLabel(display) && sameSize(display),
        (display: T) => sameId(display) && sameSize(display),
        sameLabel,
        sameId,
        sameBounds,
    ];

    for (const check of checks) {
        const match = displays.find(check);
        if (match) {
            return match;
        }
    }
    return undefined;
}

// Keeps the window at the same spot relative to its display, shrunk and moved as needed
// so it always fits inside the display's work area.
export function placeWindow(state: WindowState, display: DisplayLike): Rectangle {
    const area = display.workArea;
    const width = Math.min(state.bounds.width, area.width);
    const height = Math.min(state.bounds.height, area.height);
    const x = area.x + (state.bounds.x - state.display.workArea.x);
    const y = area.y + (state.bounds.y - state.display.workArea.y);

    return {
        x: clamp(x, area.x, area.x + area.width - width),
        y: clamp(y, area.y, area.y + area.height - height),
        width,
        height,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function rectsEqual(a: Rectangle, b: Rectangle): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function isRect(value: unknown): value is Rectangle {
    const rect = value as Partial<Rectangle> | null;
    return (
        typeof rect === 'object' &&
        rect !== null &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    );
}

function isWindowState(value: unknown): value is WindowState {
    const state = value as Partial<WindowState> | null;
    return (
        typeof state === 'object' &&
        state !== null &&
        isRect(state.bounds) &&
        typeof state.isMaximized === 'boolean' &&
        typeof state.isFullScreen === 'boolean' &&
        typeof state.display === 'object' &&
        state.display !== null &&
        typeof state.display.id === 'number' &&
        typeof state.display.label === 'string' &&
        isRect(state.display.bounds) &&
        isRect(state.display.workArea)
    );
}
