'use strict';

// A small model of Twitch's live HLS delivery, based on playlists captured from twitch.tv:
//  - every playback session (access token) gets its own master and media playlists
//  - all sessions share the same live segments, one per "tick", numbered with the channel-wide sequence
//  - a session that starts with a preroll numbers its segments from 0 (MEDIA-SEQUENCE), while
//    #EXT-X-TWITCH-LIVE-SEQUENCE carries the channel-wide number of the first live segment
//  - such sessions label live segments with a program date time that is ~780ms off
//  - ad segments are titled "Amazon|..." and announced by a twitch-stitched-ad DATERANGE
//  - some breaks only announce the ad (DATERANGE markers) while every segment stays live

const FULL_LADDER = [
    { name: '1080p60', resolution: '1920x1080', fps: '60.000', bandwidth: 6000000 },
    { name: '720p60', resolution: '1280x720', fps: '60.000', bandwidth: 3400000 },
    { name: '480p30', resolution: '852x480', fps: '30.000', bandwidth: 1400000 },
    { name: '360p30', resolution: '640x360', fps: '30.000', bandwidth: 700000 },
];
const LOW_LADDER = FULL_LADDER.slice(3);
const WINDOW = 6;
const BASE_TIME = Date.parse('2026-09-13T01:00:00.000Z');

class FakeTwitch {
    // plan(playerType, sessionNumber) -> { preroll, midrolls: [{ start, length }], markerOnly: [{ start, length }] }
    constructor(plan) {
        this.plan = plan;
        this.tick = 1000;
        this.sessions = new Map();
        this.sessionCount = 0;
        this.requests = [];
    }

    advance(ticks = 1) {
        this.tick += ticks;
    }

    async fetch(url) {
        this.requests.push(url);
        const usher = /\/api\/channel\/hls\/([^/.]+)\.m3u8\?(.*)$/.exec(url);
        if (usher) {
            const token = JSON.parse(new URLSearchParams(usher[2]).get('token'));
            return new Response(this.openSession(token.player_type), { status: 200 });
        }
        const media = /^https:\/\/weaver\.test\/(\d+)\/([^/]+)\.m3u8$/.exec(url);
        if (media) {
            return new Response(this.mediaPlaylist(Number(media[1]), media[2]), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    }

    openSession(playerType) {
        const id = ++this.sessionCount;
        const plan = Object.assign({ preroll: 0, midrolls: [], markerOnly: [] }, this.plan(playerType, id));
        const ladder = playerType === 'autoplay' ? LOW_LADDER : FULL_LADDER;
        this.sessions.set(id, { id, playerType, ladder, start: this.tick, preroll: plan.preroll, midrolls: plan.midrolls, markerOnly: plan.markerOnly });
        const lines = ['#EXTM3U', '#EXT-X-TWITCH-INFO:NODE="test",SERVER-TIME="1789264318.61"'];
        for (const variant of ladder) {
            lines.push(`#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${variant.name}",NAME="${variant.name}",AUTOSELECT=YES,DEFAULT=YES`);
            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.resolution},CODECS="avc1.64002A,mp4a.40.2",VIDEO="${variant.name}",FRAME-RATE=${variant.fps}`);
            lines.push(`https://weaver.test/${id}/${variant.name}.m3u8`);
        }
        return lines.join('\n') + '\n';
    }

    isAd(session, tick) {
        if (session.preroll && tick < session.start + session.preroll) return true;
        return session.midrolls.some((m) => tick >= m.start && tick < m.start + m.length);
    }

    mediaPlaylist(id, variantName) {
        const session = this.sessions.get(id);
        const relative = session.preroll > 0;
        const first = Math.max(session.start, this.tick - WINDOW + 1);
        const lines = [];
        let mediaSequence = null;
        let liveSequence = null;
        let hasAds = false;
        let previousWasAd = false;
        const body = [];
        for (let tick = first; tick <= this.tick; tick++) {
            const seq = relative ? tick - session.start : tick;
            if (mediaSequence === null) mediaSequence = seq;
            const ad = this.isAd(session, tick);
            if (ad) {
                hasAds = true;
                if (!previousWasAd) body.push('#EXT-X-DISCONTINUITY');
                body.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(BASE_TIME + tick * 2002).toISOString()}`);
                body.push('#EXTINF:2.002,Amazon|123456');
                body.push(`https://seg.test/${id}/${variantName}/ad-${tick}.ts`);
            } else {
                if (liveSequence === null) liveSequence = tick;
                if (previousWasAd) body.push('#EXT-X-DISCONTINUITY');
                body.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(BASE_TIME + tick * 2000 + (relative ? 780 : 0)).toISOString()}`);
                body.push('#EXTINF:2.000,live');
                body.push(`https://seg.test/${id}/${variantName}/live-${tick}.ts`);
            }
            previousWasAd = ad;
        }
        lines.push('#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);
        if (liveSequence !== null) lines.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${liveSequence}`);
        lines.push(`#EXT-X-DATERANGE:ID="playlist-creation-1",CLASS="timestamp",START-DATE="2026-09-13T01:00:00.000Z",END-ON-NEXT=YES,X-SERVER-TIME="1789264318.82"`);
        if (hasAds || session.markerOnly.some((m) => this.tick >= m.start && this.tick < m.start + m.length)) {
            lines.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-09-13T01:00:00.000Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"');
        }
        lines.push(...body);
        if (!previousWasAd) {
            lines.push(`#EXT-X-TWITCH-PREFETCH:https://seg.test/${id}/${variantName}/live-${this.tick + 1}.ts`);
        }
        return lines.join('\n') + '\n';
    }
}

module.exports = { FakeTwitch };
