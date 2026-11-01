import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource, extractYouTubeId } from './utils.js';

const id = 'dQw4w9WgXcQ';

test('extractYouTubeId reads watch, short, embed, live and shorts links', () => {
    for (const link of [
        `https://www.youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}?t=5`,
        `https://www.youtube.com/embed/${id}`,
        `https://www.youtube.com/live/${id}`,
        `https://www.youtube.com/shorts/${id}`,
        `https://www.youtube-nocookie.com/embed/${id}`,
    ]) {
        assert.equal(extractYouTubeId(link), id, link);
    }
});

test('extractYouTubeId leaves anything else as typed', () => {
    assert.equal(extractYouTubeId(`  ${id} `), id);
    assert.equal(
        extractYouTubeId('https://example.com/embed/not-youtube'),
        'https://example.com/embed/not-youtube',
    );
});

test('detectSource classifies pasted lines', () => {
    assert.deepEqual(detectSource(`https://youtu.be/${id}`), { type: 'YT', value: id });
    assert.deepEqual(detectSource('https://example.com/live.m3u8'), {
        type: 'CU',
        value: 'https://example.com/live.m3u8',
    });
    assert.deepEqual(detectSource('file:///C:/clip.mp4'), {
        type: 'LF',
        value: 'file:///C:/clip.mp4',
    });
    assert.equal(detectSource('not a link'), null);
    assert.equal(detectSource('ftp://example.com/x'), null);
    assert.equal(detectSource('   '), null);
});
