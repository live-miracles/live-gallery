import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxBaseWidth, boxMargin, boxOuterHeight, computeFitLayout } from './fit-layout.js';

const sizes = [
    [1366, 700],
    [1400, 810],
    [1920, 1000],
    [2560, 1380],
    [1863.33, 1096.67],
];

test('a fitted wall stays inside the window', () => {
    for (const [width, height] of sizes) {
        for (let count = 1; count <= 60; count += 1) {
            const { boxWidth, columns, fitsWindow } = computeFitLayout(count, width, height);
            if (!fitsWindow) {
                continue;
            }
            const rows = Math.ceil(count / columns);
            assert.ok(columns * (boxWidth + boxMargin) <= width - 1, `${count} boxes too wide`);
            assert.ok(rows * boxOuterHeight(boxWidth) <= height - 1, `${count} boxes too tall`);
        }
    }
});

test('fit fills the window for a few boxes', () => {
    const { boxWidth, columns, fitsWindow } = computeFitLayout(16, 1920, 1000);
    assert.equal(fitsWindow, true);
    assert.equal(columns, 4);
    assert.ok(boxWidth > 400);
});

test('fit never shrinks boxes below 100% and scrolls instead', () => {
    for (const [width, height] of sizes) {
        const layout = computeFitLayout(100, width, height);
        assert.equal(layout.fitsWindow, false);
        assert.ok(layout.boxWidth >= boxBaseWidth);
        assert.ok(layout.columns * (layout.boxWidth + boxMargin) <= width - 1);
        // The row is filled: one more column of the smallest size would not fit.
        assert.ok((layout.columns + 1) * (boxBaseWidth + boxMargin) > width - 2);
    }
});

test('a window narrower than one box still gets one column', () => {
    const layout = computeFitLayout(5, 200, 600);
    assert.equal(layout.columns, 1);
    assert.equal(layout.boxWidth, boxBaseWidth);
});
