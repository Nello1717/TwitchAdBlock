'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistLib } = require('../twitch-adblock-hq.user.js');

const Lib = createPlaylistLib();

// Shapes taken from real twitch.tv playlists (URLs shortened, long attributes trimmed).
const MASTER = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-edge",MANIFEST-NODE-TYPE="weaver_cluster",SERVER-TIME="1789264318.61",USER-COUNTRY="CA"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=6135000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://use23.playlist.ttvnw.net/v1/playlist/chunked.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://use23.playlist.ttvnw.net/v1/playlist/720p60.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS="avc1.4D401E,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000
https://use23.playlist.ttvnw.net/v1/playlist/360p30.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://use23.playlist.ttvnw.net/v1/playlist/audio_only.m3u8
`;

function clean(first, count) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-TWITCH-LIVE-SEQUENCE:${first}`,
        '#EXT-X-DATERANGE:ID="playlist-creation-1789264318",CLASS="timestamp",START-DATE="2026-09-13T01:51:58.822Z",END-ON-NEXT=YES,X-SERVER-TIME="1789264318.82"'];
    for (let i = 0; i < count; i++) {
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(Date.parse('2026-09-13T01:51:29.887Z') + (first + i) * 2000).toISOString()}`);
        lines.push('#EXTINF:2.000,live');
        lines.push(`https://edge.test/main/live-${first + i}.ts`);
    }
    lines.push(`#EXT-X-TWITCH-PREFETCH:https://edge.test/main/live-${first + count}.ts`);
    return lines.join('\n') + '\n';
}

const PREROLL = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TWITCH-ELAPSED-SECS:33401.368
#EXT-X-START:TIME-OFFSET=0.000
#EXT-X-DATERANGE:ID="stitched-ad-1789264386-30264999985",CLASS="twitch-stitched-ad",START-DATE="2026-09-13T01:53:06.735Z",DURATION=30.265,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL",X-TV-TWITCH-AD-POD-LENGTH="1"
#EXT-X-DATERANGE:ID="quartile-1789264386-0",CLASS="twitch-ad-quartile",START-DATE="2026-09-13T01:53:06.735Z",DURATION=2.002,X-TV-TWITCH-AD-QUARTILE="0"
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:53:06.735Z
#EXTINF:2.002,Amazon|587683009409116086
https://edge.test/ad-0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:53:08.737Z
#EXTINF:2.002,Amazon|587683009409116086
https://edge.test/ad-1.ts
`;

// A session whose preroll just ended: ad segments numbered from 0, then live segments that carry the channel-wide
// sequence in #EXT-X-TWITCH-LIVE-SEQUENCE (observed: session segment 16 == channel segment 16913).
const AFTER_PREROLL = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:14
#EXT-X-TWITCH-LIVE-SEQUENCE:16913
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-09-13T01:57:20.990Z",DURATION=30.265
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:57:49.017Z
#EXTINF:2.002,Amazon|587683009409116086
https://edge.test/backup/ad-14.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:57:51.019Z
#EXTINF:0.235,Amazon|587683009409116086
https://edge.test/backup/ad-15.ts
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:57:51.254Z
#EXTINF:2.002,live
https://edge.test/backup/live-a.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T01:57:53.256Z
#EXTINF:2.001,live
https://edge.test/backup/live-b.ts
#EXT-X-TWITCH-PREFETCH:https://edge.test/backup/live-c.ts
`;

test('parseMaster describes every rendition', () => {
    const variants = Lib.parseMaster(MASTER);
    assert.equal(variants.length, 4);
    assert.deepEqual(variants.map((v) => v.label), ['1080p60', '720p60', '360p', 'audio only']);
    assert.equal(variants[0].key, '1920x1080@60/avc');
    assert.equal(variants[0].url, 'https://use23.playlist.ttvnw.net/v1/playlist/chunked.m3u8');
    assert.equal(variants[0].bandwidth, 6135000);
    assert.equal(variants[3].key, 'audio/audio_only');
});

test('codecFamily groups codec strings', () => {
    assert.equal(Lib.codecFamily('avc1.64002A,mp4a.40.2'), 'avc');
    assert.equal(Lib.codecFamily('hev1.1.6.L150.90,mp4a.40.2'), 'hevc');
    assert.equal(Lib.codecFamily('hvc1.2.4.L153.B0'), 'hevc');
    assert.equal(Lib.codecFamily('av01.0.12M.10'), 'av1');
    assert.equal(Lib.codecFamily('mp4a.40.2'), 'audio');
});

test('matchVariant prefers the identical rendition', () => {
    const [source, hd, sd] = Lib.parseMaster(MASTER);
    const backup = Lib.parseMaster(MASTER.replaceAll('use23', 'use99'));
    const exact = Lib.matchVariant(backup, source);
    assert.equal(exact.exact, true);
    assert.equal(exact.variant.url, 'https://use99.playlist.ttvnw.net/v1/playlist/chunked.m3u8');

    const lowOnly = backup.filter((v) => v.height <= 360);
    const lower = Lib.matchVariant(lowOnly, hd);
    assert.equal(lower.exact, false);
    assert.equal(lower.variant.height, 360);

    assert.equal(Lib.matchVariant(backup.filter((v) => v.height > 720), sd), null, 'never picks a higher rendition than requested');

    const hevc = Object.assign({}, source, { codec: 'hevc', key: '1920x1080@60/hevc' });
    assert.equal(Lib.matchVariant(lowOnly, hevc), null, 'never switches codec');

    const lowBitrate = backup.map((v) => Object.assign({}, v, { bandwidth: v.bandwidth / 2 }));
    assert.equal(Lib.matchVariant(lowBitrate, source).exact, false, 'a bitrate-capped rendition is not identical');
});

test('parseMedia reads a clean live playlist', () => {
    const playlist = Lib.parseMedia(clean(5573, 4));
    assert.equal(playlist.segments.length, 4);
    assert.deepEqual(playlist.segments.map((s) => s.gseq), [5573, 5574, 5575, 5576]);
    assert.equal(playlist.prefetch.length, 1);
    assert.equal(Lib.isShowingAd(playlist), false);
    assert.equal(Lib.hasAdSegments(playlist), false);
    assert.equal(playlist.hasAdMarkers, false);
});

test('parseMedia recognises an ad-only playlist', () => {
    const playlist = Lib.parseMedia(PREROLL);
    assert.equal(playlist.hasAdMarkers, true);
    assert.equal(Lib.isShowingAd(playlist), true);
    assert.equal(Lib.newestLiveSegment(playlist), null);
    assert.ok(playlist.segments.every((s) => !s.live && s.gseq === null));
});

test('parseMedia numbers post-ad live segments with the channel-wide sequence', () => {
    const playlist = Lib.parseMedia(AFTER_PREROLL);
    assert.equal(Lib.isShowingAd(playlist), false, 'the newest segment is live, the ad is over');
    assert.equal(Lib.hasAdSegments(playlist), true);
    const live = playlist.segments.filter((s) => s.live);
    assert.deepEqual(live.map((s) => s.gseq), [16913, 16914]);
    assert.equal(live[0].seq, 16, 'MEDIA-SEQUENCE numbering is session-relative');
});

test('parseMedia counts live segments skipped by a midroll', () => {
    const text = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:500
#EXT-X-TWITCH-LIVE-SEQUENCE:500
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T02:00:00.000Z
#EXTINF:2.000,live
https://edge.test/live-500.ts
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T02:00:02.000Z
#EXTINF:2.002,Amazon|1
https://edge.test/ad-1.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T02:00:04.002Z
#EXTINF:2.002,Amazon|1
https://edge.test/ad-2.ts
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T02:00:06.300Z
#EXTINF:2.000,live
https://edge.test/live-503.ts
`;
    const playlist = Lib.parseMedia(text);
    assert.deepEqual(playlist.segments.filter((s) => s.live).map((s) => s.gseq), [500, 503]);
});

test('parseMedia keeps sequence numbers learned from earlier refreshes', () => {
    const memo = new Map();
    Lib.rememberSequence(memo, Lib.parseMedia(clean(100, 3)));
    // Same segments, but the header now claims a different starting number.
    const shifted = clean(100, 3).replace('#EXT-X-TWITCH-LIVE-SEQUENCE:100', '#EXT-X-TWITCH-LIVE-SEQUENCE:900');
    assert.deepEqual(Lib.parseMedia(shifted, memo).segments.map((s) => s.gseq), [100, 101, 102]);
});

test('parseMedia does not treat unknown segment titles as ads without ad markers', () => {
    const playlist = Lib.parseMedia(clean(10, 2).replaceAll(',live', ','));
    assert.ok(playlist.segments.every((s) => s.live));
});

test('timeline merges sessions without duplicates or gaps', () => {
    const timeline = Lib.createTimeline();
    const sequence = Lib.createSequenceState();
    const main = Lib.parseMedia(clean(100, 3));
    Lib.appendToTimeline(timeline, main.segments, 'hd', 'main', sequence);
    timeline.virtual = true;
    const backup = Lib.parseMedia(clean(101, 4).replaceAll('/main/', '/backup/'));
    const change = Lib.appendToTimeline(timeline, backup.segments, 'hd', 'backup', sequence);
    assert.equal(change.appended, 2);
    assert.equal(change.switchedSource, true);
    assert.equal(change.resumedAfterGap, false);
    assert.deepEqual(timeline.segments.map((s) => s.vseq), [100, 101, 102, 103, 104]);
    assert.ok(timeline.segments.every((s) => !s.discontinuity), 'same rendition from another session is seamless');
    assert.equal(timeline.segments[3].uri, 'https://edge.test/backup/live-103.ts');
    for (let i = 1; i < timeline.segments.length; i++) {
        assert.equal(timeline.segments[i].pdtMs - timeline.segments[i - 1].pdtMs, 2000, 'program date time stays continuous');
    }
});

test('timeline closes gaps and marks discontinuities', () => {
    const timeline = Lib.createTimeline();
    const sequence = Lib.createSequenceState();
    timeline.virtual = true;
    Lib.appendToTimeline(timeline, Lib.parseMedia(clean(100, 2)).segments, 'hd', 'main', sequence);
    const change = Lib.appendToTimeline(timeline, Lib.parseMedia(clean(130, 2)).segments, 'hd', 'main', sequence);
    assert.equal(change.resumedAfterGap, true);
    assert.deepEqual(timeline.segments.map((s) => s.vseq), [100, 101, 102, 103], 'the player sees contiguous numbers');
    assert.deepEqual(timeline.segments.map((s) => s.discontinuity), [false, false, true, false]);

    Lib.appendToTimeline(timeline, Lib.parseMedia(clean(132, 1).replaceAll('/main/', '/low/')).segments, 'sd', 'low', sequence);
    assert.equal(timeline.segments[4].discontinuity, true, 'rendition change');

    Lib.trimTimeline(timeline, 2);
    const rendered = Lib.renderTimeline(timeline, { targetDuration: 6 });
    assert.match(rendered, /#EXT-X-MEDIA-SEQUENCE:103\n/);
    assert.match(rendered, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
    const reparsed = Lib.parseMedia(rendered);
    assert.deepEqual(reparsed.segments.map((s) => s.uri), ['https://edge.test/main/live-131.ts', 'https://edge.test/low/live-132.ts']);
});

test('timeline resumes near the live edge after a gap', () => {
    const timeline = Lib.createTimeline();
    const sequence = Lib.createSequenceState();
    timeline.virtual = true;
    Lib.appendToTimeline(timeline, Lib.parseMedia(clean(100, 2)).segments, 'hd', 'main', sequence, 3);
    const change = Lib.appendToTimeline(timeline, Lib.parseMedia(clean(130, 14)).segments, 'hd', 'main', sequence, 3);
    assert.equal(change.appended, 3);
    assert.deepEqual(timeline.segments.map((s) => s.gseq), [100, 101, 141, 142, 143]);
    assert.deepEqual(timeline.segments.map((s) => s.vseq), [100, 101, 102, 103, 104]);
    // Without a gap every new segment is kept.
    assert.equal(Lib.appendToTimeline(timeline, Lib.parseMedia(clean(144, 5)).segments, 'hd', 'main', sequence, 3).appended, 5);
});

test('timeline numbering is shared by variants of a stream', () => {
    const sequence = Lib.createSequenceState();
    const hd = Lib.createTimeline();
    hd.virtual = true;
    Lib.appendToTimeline(hd, Lib.parseMedia(clean(100, 2)).segments, 'hd', 'main', sequence);
    Lib.appendToTimeline(hd, Lib.parseMedia(clean(130, 2)).segments, 'hd', 'main', sequence);
    // The player switches quality: the new variant must reuse the same numbers for the same content.
    const sd = Lib.createTimeline();
    sd.virtual = true;
    Lib.appendToTimeline(sd, Lib.parseMedia(clean(126, 6)).segments, 'sd', 'main', sequence);
    assert.deepEqual(sd.segments.map((s) => [s.gseq, s.vseq]), [[130, 102], [131, 103]]);
});

test('renderTimeline with no segments yields a valid empty live playlist', () => {
    const rendered = Lib.renderTimeline(Lib.createTimeline(), { targetDuration: 6, nextSequence: 42 });
    assert.equal(rendered, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n');
});
