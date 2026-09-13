'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistLib, workerMain, DEFAULT_SETTINGS, TUNING } = require('../twitch-adblock-hq.user.js');
const { FakeTwitch } = require('./fake-twitch.js');

const TAG = '__twitchAdBlockHQ';
const Lib = createPlaylistLib();
const MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/somechannel.m3u8?allow_source=true&play_session_id=abc&p=1&token=' + encodeURIComponent(JSON.stringify({ player_type: 'popout' })) + '&sig=x';

// Runs workerMain against FakeTwitch, playing the role of both the page (access tokens) and the video player.
function createHarness(plan, settings = {}, tuning = {}) {
    const twitch = new FakeTwitch(plan);
    const listeners = [];
    const statuses = [];
    const scope = {
        fetch: (input) => twitch.fetch(typeof input === 'string' ? input : input.url),
        addEventListener: (type, listener) => listeners.push(listener),
        postMessage: (message) => {
            if (message.type === 'status') {
                statuses.push(message.status);
            } else if (message.type === 'page-fetch') {
                const body = JSON.parse(message.options.body);
                const token = { value: JSON.stringify({ player_type: body.variables.playerType }), signature: 'sig' };
                setImmediate(() => dispatch({ [TAG]: true, type: 'page-fetch-result', id: message.id, value: { status: 200, body: JSON.stringify({ data: { streamPlaybackAccessToken: token } }) } }));
            }
        },
    };
    const dispatch = (data) => listeners.forEach((listener) => listener({ data, stopImmediatePropagation() {} }));
    workerMain({
        messageTag: TAG,
        settings: Object.assign({}, DEFAULT_SETTINGS, settings),
        tuning: Object.assign({}, TUNING, { sessionWaitMs: 1000 }, tuning),
        gql: {},
        defaults: { clientId: 'client', tokenHash: 'hash' },
    }, scope, createPlaylistLib);

    const outputs = [];
    return {
        twitch,
        statuses,
        outputs,
        dispatch,
        async openStream() {
            const master = await (await scope.fetch(MASTER_URL)).text();
            return Lib.parseMaster(master);
        },
        // One player refresh: time moves on by a segment, then the player reloads its media playlist.
        async refresh(url) {
            twitch.advance();
            const text = await (await scope.fetch(url)).text();
            outputs.push({ url, text, tick: twitch.tick });
            return text;
        },
    };
}

// What the player sees must behave like one continuous, ad-free live stream.
function assertPlayerView(outputs) {
    const tickBySequence = new Map();
    let newest = -1;
    for (const { text } of outputs) {
        const playlist = Lib.parseMedia(text);
        for (const segment of playlist.segments) {
            assert.ok(!segment.uri.includes('/ad-'), `ad segment reached the player: ${segment.uri}`);
            const tick = Number(/live-(\d+)\.ts$/.exec(segment.uri)[1]);
            if (tickBySequence.has(segment.seq)) {
                assert.equal(tickBySequence.get(segment.seq), tick, `sequence ${segment.seq} changed content`);
            } else {
                assert.ok(segment.seq > newest, `sequence ${segment.seq} appeared after ${newest}`);
                tickBySequence.set(segment.seq, tick);
                newest = segment.seq;
            }
        }
        for (const uri of playlist.prefetch) {
            assert.ok(!uri.includes('/ad-'), 'ad prefetch reached the player');
        }
    }
    const ticks = [...tickBySequence.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
    for (let i = 1; i < ticks.length; i++) {
        assert.ok(ticks[i] > ticks[i - 1], 'content never repeats or goes back in time');
    }
    return ticks;
}

function segmentsOf(text) {
    return Lib.parseMedia(text).segments.map((s) => s.uri.replace('https://seg.test/', ''));
}

test('without ads the playlist is passed through untouched', async () => {
    const harness = createHarness(() => ({}));
    const [source] = await harness.openStream();
    for (let i = 0; i < 5; i++) {
        const text = await harness.refresh(source.url);
        assert.equal(text, harness.twitch.mediaPlaylist(1, '1080p60'));
    }
    assert.equal(harness.twitch.sessionCount, 1, 'no backup sessions were opened');
});

test('preroll: waits at full quality, then plays a backup at the same quality, then returns to the main session', async () => {
    // Main session: 12 ad segments. embed: short 3 segment preroll. site/popout: longer than main's.
    const plan = (playerType, n) => (n === 1 ? { preroll: 12 } : playerType === 'embed' ? { preroll: 3 } : { preroll: 30 });
    const harness = createHarness(plan, { fallbackMode: 'hold' });
    const [source] = await harness.openStream();

    const first = await harness.refresh(source.url);
    assert.equal(Lib.parseMedia(first).segments.length, 0, 'holds instead of showing an ad or a lower quality');
    assert.equal(harness.statuses.at(-1).mode, 'hold');

    for (let i = 0; i < 3; i++) await harness.refresh(source.url);
    const backup = segmentsOf(harness.outputs.at(-1).text);
    assert.ok(backup.length > 0 && backup.every((uri) => /^\d+\/1080p60\/live-/.test(uri)), `plays 1080p60 from a backup: ${backup}`);
    assert.ok(!backup.some((uri) => uri.startsWith('1/')));
    assert.equal(harness.statuses.at(-1).mode, 'backup');
    assert.equal(harness.statuses.at(-1).source, 'embed');

    for (let i = 0; i < 20; i++) await harness.refresh(source.url);
    const final = segmentsOf(harness.outputs.at(-1).text);
    assert.ok(final.slice(-3).every((uri) => uri.startsWith('1/1080p60/')), `back on the main session: ${final}`);
    assert.equal(harness.statuses.at(-1).adActive, false);
    assert.match(harness.outputs.at(-1).text, /#EXT-X-TWITCH-PREFETCH:https:\/\/seg\.test\/1\//, 'low latency prefetch is restored');

    const ticks = assertPlayerView(harness.outputs);
    for (let i = 1; i < ticks.length; i++) {
        assert.equal(ticks[i], ticks[i - 1] + 1, 'no segment was skipped once playback started');
    }
});

test("lowres: shows 360p while nothing ad-free exists at the selected quality, then upgrades", async () => {
    const plan = (playerType, n) => (n === 1 ? { preroll: 10 } : playerType === 'embed' ? { preroll: 4 } : playerType === 'autoplay' ? {} : { preroll: 30 });
    const harness = createHarness(plan, { fallbackMode: 'lowres' });
    const [source] = await harness.openStream();

    await harness.refresh(source.url);
    assert.ok(segmentsOf(harness.outputs.at(-1).text).every((uri) => uri.includes('/360p30/')), 'starts with the 360p ad-free stream');
    assert.equal(harness.statuses.at(-1).mode, 'lowres');

    for (let i = 0; i < 5; i++) await harness.refresh(source.url);
    const upgraded = Lib.parseMedia(harness.outputs.at(-1).text).segments;
    assert.ok(upgraded.at(-1).uri.includes('/1080p60/'), 'upgrades to 1080p60 as soon as a backup is ad-free');
    assert.ok(upgraded.some((s) => s.discontinuity), 'rendition change is flagged');

    for (let i = 0; i < 20; i++) await harness.refresh(source.url);
    assert.ok(segmentsOf(harness.outputs.at(-1).text).slice(-3).every((uri) => uri.startsWith('1/1080p60/')));
    const ticks = assertPlayerView(harness.outputs);
    for (let i = 1; i < ticks.length; i++) {
        assert.equal(ticks[i], ticks[i - 1] + 1, 'lowres mode never skips content');
    }
});

test('midroll: switches to an ad-free backup seamlessly and back again', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1006, length: 10 }] } : {});
    const harness = createHarness(plan);
    const [source] = await harness.openStream();
    for (let i = 0; i < 30; i++) await harness.refresh(source.url);

    const view = harness.outputs.map((o) => segmentsOf(o.text).at(-1));
    assert.ok(view.some((uri) => !uri.startsWith('1/')), 'a backup covered the midroll');
    assert.ok(view.at(-1).startsWith('1/'), 'returned to the main session');
    const ticks = assertPlayerView(harness.outputs);
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i], ticks[i - 1] + 1);
    const discontinuities = harness.outputs.flatMap((o) => Lib.parseMedia(o.text).segments.filter((s) => s.discontinuity));
    assert.equal(discontinuities.length, 0, 'switching between sessions of the same rendition needs no discontinuity');
});

test('hold: resumes with a discontinuity when the ad ends before any backup is ad-free', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1004, length: 8 }] } : { preroll: 40 });
    const harness = createHarness(plan, { fallbackMode: 'hold' });
    const [source] = await harness.openStream();
    for (let i = 0; i < 20; i++) await harness.refresh(source.url);

    assert.ok(harness.statuses.some((s) => s.mode === 'hold'));
    assert.ok(harness.statuses.some((s) => s.resumedAfterGap), 'the page is told playback resumed after a gap');
    const segments = Lib.parseMedia(harness.outputs.at(-1).text).segments;
    assert.ok(segments.every((s) => s.uri.includes('/1/1080p60/')), 'only full quality segments');
    assertPlayerView(harness.outputs);
});

test('hold: notices the end of the ad while the paused player makes no requests', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1003, length: 5 }] } : { preroll: 40 });
    const harness = createHarness(plan, { fallbackMode: 'hold' }, { holdRefreshMs: 20 });
    const [source] = await harness.openStream();
    for (let i = 0; i < 4; i++) await harness.refresh(source.url);
    assert.equal(harness.statuses.at(-1).mode, 'hold');

    // The page pauses the player: no more playlist requests while Twitch moves past the ad.
    harness.twitch.advance(8);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.statuses.at(-1).adActive, false, 'the worker refreshed the playlist on its own');
    assert.equal(harness.statuses.at(-1).mode, 'main');

    await harness.refresh(source.url);
    const segments = Lib.parseMedia(harness.outputs.at(-1).text).segments;
    assert.ok(segments.at(-1).uri.endsWith(`live-${harness.twitch.tick}.ts`), 'the resumed player is at the live edge');
    assertPlayerView(harness.outputs);
});

test('quality switches during an ad keep sequence numbers aligned', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1003, length: 12 }] } : playerType === 'embed' ? {} : { preroll: 40 });
    const harness = createHarness(plan, { fallbackMode: 'hold' });
    const [source, hd] = await harness.openStream();
    for (let i = 0; i < 6; i++) await harness.refresh(source.url);
    for (let i = 0; i < 6; i++) await harness.refresh(hd.url);
    for (let i = 0; i < 12; i++) await harness.refresh(source.url);
    assertPlayerView(harness.outputs);
    const hdSegments = harness.outputs.filter((o) => o.url === hd.url).flatMap((o) => segmentsOf(o.text));
    assert.ok(hdSegments.every((uri) => uri.includes('/720p60/')), '720p60 is served from a 720p60 backup');
});

test('ad markers without ad segments: stays on the main session and hides the markers from the player', async () => {
    const plan = (playerType, n) => (n === 1 ? { markerOnly: [{ start: 1003, length: 8 }] } : { preroll: 40 });
    const harness = createHarness(plan, { fallbackMode: 'lowres' });
    const [source] = await harness.openStream();
    for (let i = 0; i < 16; i++) await harness.refresh(source.url);
    for (const { text } of harness.outputs) {
        assert.ok(!text.includes('stitched'), 'ad markers never reach the player');
        assert.ok(segmentsOf(text).every((uri) => uri.startsWith('1/1080p60/')), 'full quality from the main session, never a 360p fallback');
    }
    assert.ok(harness.statuses.every((s) => s.mode !== 'lowres' && s.mode !== 'hold'));
    assert.equal(harness.twitch.sessionCount, 1, 'no backup sessions are opened for an announcement alone');
    const ticks = assertPlayerView(harness.outputs);
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i], ticks[i - 1] + 1);
});

test('backup sessions are reused when an ad follows shortly after another', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1003, length: 4 }, { start: 1020, length: 4 }] } : {});
    const harness = createHarness(plan);
    const [source] = await harness.openStream();
    for (let i = 0; i < 12; i++) await harness.refresh(source.url);
    const sessionsAfterFirstAd = harness.twitch.sessionCount;
    for (let i = 0; i < 16; i++) await harness.refresh(source.url);
    assert.ok(harness.statuses.filter((s) => s.mode === 'backup').length >= 2);
    assert.equal(harness.twitch.sessionCount, sessionsAfterFirstAd, 'no new access tokens for the second ad');
    assertPlayerView(harness.outputs);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('warm backups: a full quality backup is ready the moment an ad starts', async () => {
    // Every full quality backup session starts with its own short preroll; the player's session gets a midroll later.
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1012, length: 6 }] } : playerType === 'autoplay' ? {} : { preroll: 4 });
    const run = async (settings) => {
        const harness = createHarness(plan, Object.assign({ fallbackMode: 'lowres' }, settings), { warmStartDelayMs: 0, warmPollMs: 10 });
        const [source] = await harness.openStream();
        for (let i = 0; i < 22; i++) {
            await harness.refresh(source.url);
            await sleep(25);
        }
        assertPlayerView(harness.outputs);
        return harness;
    };

    const warm = await run({ keepBackupsWarm: true });
    const warmModes = warm.statuses.filter((s) => s.adActive).map((s) => s.mode);
    assert.equal(warmModes[0], 'backup', `full quality from the first ad refresh: ${warmModes}`);
    assert.ok(!warmModes.includes('lowres') && !warmModes.includes('hold'));
    assert.ok(warm.twitch.sessionCount <= 1 + 5, 'warm sessions are not reopened over and over');

    const cold = await run({ keepBackupsWarm: false });
    const coldModes = cold.statuses.filter((s) => s.adActive).map((s) => s.mode);
    assert.equal(coldModes[0], 'lowres', `without warm sessions the ad starts on the fallback: ${coldModes}`);
    assert.ok(coldModes.includes('backup'), 'and switches to full quality once a backup is ad-free');
});

test('warm backups are renewed without losing an ad-free backup', async () => {
    const plan = (playerType, n) => (n === 1 ? { midrolls: [{ start: 1032, length: 5 }] } : playerType === 'autoplay' ? {} : { preroll: 3 });
    const harness = createHarness(plan, { fallbackMode: 'lowres' }, { warmStartDelayMs: 0, warmPollMs: 10, sessionMaxAgeMs: 250 });
    const [source] = await harness.openStream();
    for (let i = 0; i < 40; i++) {
        await harness.refresh(source.url);
        await sleep(25);
    }
    assert.ok(harness.twitch.sessionCount > 1 + 5, 'sessions were renewed');
    const modes = harness.statuses.filter((s) => s.adActive).map((s) => s.mode);
    assert.equal(modes[0], 'backup', `a renewed or still-valid backup covers the ad: ${modes}`);
    assertPlayerView(harness.outputs);
});

test('simulateAd exercises the backup path on demand', async () => {
    const harness = createHarness(() => ({}));
    const [source] = await harness.openStream();
    await harness.refresh(source.url);
    harness.dispatch({ [TAG]: true, type: 'simulate-ad', seconds: 60 });
    await harness.refresh(source.url);
    await harness.refresh(source.url);
    assert.equal(harness.statuses.at(-1).mode, 'backup');
    assert.ok(segmentsOf(harness.outputs.at(-1).text).at(-1).startsWith('2/1080p60/'));
    assertPlayerView(harness.outputs);
});

test('failed access token requests fall back gracefully', async () => {
    const harness = createHarness((playerType, n) => (n === 1 ? { preroll: 5 } : {}));
    const original = harness.twitch.fetch;
    let usherRequests = 0;
    harness.twitch.fetch = (url) => (url.includes('usher') && ++usherRequests > 1 ? Promise.resolve(new Response('', { status: 403 })) : original.call(harness.twitch, url));
    const [source] = await harness.openStream();
    for (let i = 0; i < 10; i++) await harness.refresh(source.url);
    assertPlayerView(harness.outputs);
    assert.ok(segmentsOf(harness.outputs.at(-1).text).every((uri) => uri.startsWith('1/1080p60/')), 'main session resumes after its preroll');
    const playerTypes = DEFAULT_SETTINGS.backupPlayerTypes.length + (DEFAULT_SETTINGS.fallbackMode === 'lowres' ? DEFAULT_SETTINGS.fallbackPlayerTypes.length : 0);
    assert.equal(usherRequests, 1 + playerTypes, 'failing player types are not retried on every refresh');
});
