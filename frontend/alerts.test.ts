import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAlertHistory } from './alerts.js';

const record = {
    boxId: 'test-box',
    boxTitle: 'Test source',
    boxNumber: 2,
    kind: 'video-frozen',
    message: 'Video frozen',
    active: true,
    activeSince: 1000,
    lastSeenAt: 6000,
};

test('restored active alerts become interrupted history with a fixed duration', () => {
    const [restored] = parseAlertHistory(JSON.stringify([record]));
    assert.equal(restored.active, false);
    assert.equal(restored.interrupted, true);
    assert.equal(restored.resolvedAt, 6000);
    assert.equal(restored.boxTitle, 'Test source');
});

test('history retains separate occurrences and only the latest 100 records', () => {
    const records = Array.from({ length: 105 }, (_, i) => ({ ...record, boxTitle: `Source ${i}` }));
    const restored = parseAlertHistory(JSON.stringify(records));
    assert.equal(restored.length, 100);
    assert.equal(restored[0].boxTitle, 'Source 0');
    assert.equal(restored[99].boxTitle, 'Source 99');
});

test('invalid stored history is ignored without losing valid entries', () => {
    for (const value of ['broken', '{}', 'null']) assert.deepEqual(parseAlertHistory(value), []);
    const restored = parseAlertHistory(
        JSON.stringify([
            null,
            {},
            { ...record, kind: 'toString' },
            { ...record, activeSince: '1000' },
            { ...record, resolvedAt: 0 },
            record,
        ]),
    );
    assert.equal(restored.length, 1);
});

test('resolved alerts keep their resolution time and status on restart', () => {
    const [restored] = parseAlertHistory(
        JSON.stringify([{ ...record, active: false, resolvedAt: 7000 }]),
    );
    assert.equal(restored.resolvedAt, 7000);
    assert.equal(restored.interrupted, undefined);
});
