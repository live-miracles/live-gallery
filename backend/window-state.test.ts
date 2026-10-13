import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    findSavedDisplay,
    placeWindow,
    readWindowState,
    toSavedDisplay,
    writeWindowState,
    type WindowState,
} from './window-state.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function display(id: number, label: string, x: number, width = 1920, height = 1080) {
    return {
        id,
        label,
        bounds: rect(x, 0, width, height),
        workArea: rect(x, 0, width, height - 40),
    };
}

function stateOn(
    screen: ReturnType<typeof display>,
    bounds = rect(screen.bounds.x + 100, 50, 1400, 900),
) {
    return {
        bounds,
        display: toSavedDisplay(screen),
        isMaximized: false,
        isFullScreen: true,
    } satisfies WindowState;
}

test('matches by monitor name and position when ids swap after a reboot', () => {
    const saved = display(1, 'DELL U2720Q', 0);
    const displays = [display(2, 'DELL U2720Q', 0), display(1, 'DELL U2720Q', 1920)];
    assert.equal(findSavedDisplay(toSavedDisplay(saved), displays), displays[0]);
});

test('matches by monitor name when the id changes', () => {
    const saved = display(5, 'LG HDR 4K', 1920);
    const displays = [display(1, 'Built-in', 0), display(9, 'LG HDR 4K', 1920)];
    assert.equal(findSavedDisplay(toSavedDisplay(saved), displays), displays[1]);
});

test('follows a monitor that was moved to the other side', () => {
    const saved = display(3, 'LG HDR 4K', 1920);
    const displays = [display(1, 'Built-in', 0), display(3, 'LG HDR 4K', -1920)];
    const match = findSavedDisplay(toSavedDisplay(saved), displays);
    assert.equal(match, displays[1]);
    assert.deepEqual(placeWindow(stateOn(saved), match!), rect(-1820, 50, 1400, 900));
});

test('returns nothing when the saved monitor is gone', () => {
    const saved = display(3, 'LG HDR 4K', 1920);
    const displays = [display(1, 'Built-in', 0, 1440, 900)];
    assert.equal(findSavedDisplay(toSavedDisplay(saved), displays), undefined);
});

test('shrinks and moves the window to fit a smaller display', () => {
    const saved = display(3, 'LG HDR 4K', 0, 3840, 2160);
    const small = display(3, 'LG HDR 4K', 0, 1280, 720);
    const placed = placeWindow(stateOn(saved, rect(2000, 1000, 1600, 900)), small);
    assert.deepEqual(placed, rect(0, 0, 1280, 680));
});

test('round-trips state and ignores missing or invalid files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-'));
    const file = path.join(dir, 'window-state.json');
    assert.equal(readWindowState(file), null);

    const state = stateOn(display(1, 'Built-in', 0));
    writeWindowState(file, state);
    assert.deepEqual(readWindowState(file), state);

    fs.writeFileSync(file, '{"bounds": "nope"}');
    assert.equal(readWindowState(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
});
