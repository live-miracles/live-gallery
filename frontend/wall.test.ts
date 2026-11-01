import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createSignalTracker,
    getRotationSyntaxError,
    isSolo,
    selectRotationBoxes,
    soloBoxId,
    summarizeWall,
    type BoxSignal,
} from './wall.js';

function fakeTracker() {
    let next = 1;
    const pending = new Map<number, () => void>();
    const changes: [string, BoxSignal | null][] = [];
    const tracker = createSignalTracker({
        startTimeoutMs: 20000,
        schedule: (run) => {
            pending.set(next, run);
            return next++;
        },
        cancel: (handle) => pending.delete(handle),
        onChange: (boxId, signal) => changes.push([boxId, signal]),
    });
    const fire = (): void => {
        const [handle, run] = [...pending][0];
        pending.delete(handle);
        run();
    };
    return { tracker, pending, changes, fire };
}

test('a box that never starts becomes no-video after the start timeout', () => {
    const { tracker, fire } = fakeTracker();
    tracker.set('a', 'loading');
    fire();
    assert.equal(tracker.get('a'), 'no-video');
});

test('a box that had media but stopped becomes not-playing', () => {
    const { tracker, fire } = fakeTracker();
    tracker.set('a', 'loading');
    tracker.onPlayback('a', false);
    assert.equal(tracker.get('a'), 'loading');
    fire();
    assert.equal(tracker.get('a'), 'not-playing');
});

test('playback reports play and stop outside the start window', () => {
    const { tracker } = fakeTracker();
    tracker.set('a', 'loading');
    tracker.onPlayback('a', true);
    assert.equal(tracker.get('a'), 'playing');
    tracker.onPlayback('a', false);
    assert.equal(tracker.get('a'), 'not-playing');
});

test('leaving loading cancels the timeout; clear drops everything', () => {
    const { tracker, pending, changes } = fakeTracker();
    tracker.set('a', 'loading');
    tracker.set('a', 'failed');
    assert.equal(pending.size, 0);
    tracker.set('b', 'loading');
    tracker.clear();
    assert.equal(pending.size, 0);
    assert.equal(tracker.get('a'), undefined);
    assert.deepEqual(changes[0], ['a', 'loading']);
});

test('summarizeWall counts an alerting box only under its alert', () => {
    const boxes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, configured: id !== 'e' }));
    const signals: Record<string, BoxSignal> = {
        a: 'playing',
        b: 'playing',
        c: 'failed',
        d: 'no-video',
    };
    const status = summarizeWall(boxes, (id) => signals[id], [
        { boxId: 'b', kind: 'audio-silent' },
        { boxId: 'b', kind: 'audio-clipping' },
        { boxId: 'a', kind: 'audio-clipping' },
    ]);
    assert.equal(status.live, 0);
    assert.equal(status.empty, 1);
    assert.deepEqual(status.failed, ['c']);
    assert.deepEqual(status.notPlaying, ['d']);
    assert.deepEqual(status.alerts.get('silent'), ['b']);
    assert.deepEqual(status.alerts.get('audio'), ['b', 'a']);
});

test('a box with no signal yet counts as starting', () => {
    const status = summarizeWall([{ id: 'a', configured: true }], () => undefined, []);
    assert.deepEqual(status.loading, ['a']);
});

test('rotation syntax errors', () => {
    assert.equal(getRotationSyntaxError(''), null);
    assert.equal(getRotationSyntaxError('2 4 9-11'), null);
    assert.match(getRotationSyntaxError('2-') ?? '', /Dashes need numbers/);
    assert.match(getRotationSyntaxError('5-3') ?? '', /greater than range start/);
    assert.match(getRotationSyntaxError('3-3') ?? '', /greater than range start/);
});

test('selectRotationBoxes follows the typed order and drops missing boxes', () => {
    const boxes = ['b1', 'b2', 'b3', 'b4'];
    assert.deepEqual(selectRotationBoxes(boxes, ''), boxes);
    assert.deepEqual(selectRotationBoxes(boxes, '4 1-2 9'), ['b4', 'b1', 'b2']);
    assert.deepEqual(selectRotationBoxes(boxes, '2-'), []);
    assert.deepEqual(selectRotationBoxes(boxes, '0 2'), ['b2']);
});

test('solo rules', () => {
    const wall = [
        { id: 'a', muted: false },
        { id: 'b', muted: true },
    ];
    assert.equal(isSolo(wall, 'a'), true);
    assert.equal(isSolo(wall, 'b'), false);
    assert.equal(soloBoxId(wall), 'a');
    assert.equal(soloBoxId([{ id: 'a', muted: false }]), '');
    assert.equal(
        soloBoxId([
            { id: 'a', muted: false },
            { id: 'b', muted: false },
        ]),
        '',
    );
});
