// A box is 279px wide at 100%: the 16:9 picture, a 10px meter strip and a 1px border each
// side. Its outer footprint adds the 4px margin around it.
export const boxBaseWidth = 279;
export const boxMargin = 8;
const boxChromeWidth = 12;
const boxChromeHeight = 2;
// Box sizes land on device pixels (interface size, HiDPI), so a row can come out a pixel
// wider or taller than computed. This slack keeps the last column from wrapping and the
// last row from spilling under the window edge.
const roundingSlack = 2;

export type FitLayout = {
    boxWidth: number;
    columns: number;
    // False when every box at the smallest fit size still needs more than the window, so
    // the wall scrolls.
    fitsWindow: boolean;
};

export function boxOuterHeight(boxWidth: number): number {
    return ((boxWidth - boxChromeWidth) * 9) / 16 + boxChromeHeight + boxMargin;
}

// The widest box at which every box fits in the area, trying every column count. Fit
// never shrinks boxes below `minBoxWidth` (the 100% size): past that it keeps them at
// least that size, fills the width, and the wall scrolls.
export function computeFitLayout(
    count: number,
    availableWidth: number,
    availableHeight: number,
    minBoxWidth = boxBaseWidth,
): FitLayout {
    const width = availableWidth - roundingSlack;
    const height = availableHeight - roundingSlack;
    let best = { boxWidth: 0, columns: 1 };
    for (let columns = 1; columns <= count; columns += 1) {
        const rows = Math.ceil(count / columns);
        const byWidth = width / columns - boxMargin;
        const byHeight = ((height / rows - boxMargin - boxChromeHeight) * 16) / 9 + boxChromeWidth;
        const boxWidth = Math.min(byWidth, byHeight);
        if (boxWidth > best.boxWidth) {
            best = { boxWidth, columns };
        }
    }
    if (best.boxWidth >= minBoxWidth) {
        return { boxWidth: Math.floor(best.boxWidth), columns: best.columns, fitsWindow: true };
    }

    const columns = Math.max(1, Math.floor(width / (minBoxWidth + boxMargin)));
    return {
        boxWidth: Math.max(minBoxWidth, Math.floor(width / columns - boxMargin)),
        columns,
        fitsWindow: false,
    };
}
