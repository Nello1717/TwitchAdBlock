// ==UserScript==
// @name         Twitch AdBlock HQ
// @namespace    https://github.com/Nello1717/TwitchAdBlock
// @version      1.2.0
// @description  Blocks Twitch ads without dropping the stream to low quality
// @author       Nello
// @license      MIT
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @updateURL    https://github.com/Nello1717/TwitchAdBlock/raw/main/twitch-adblock-hq.user.js
// @downloadURL  https://github.com/Nello1717/TwitchAdBlock/raw/main/twitch-adblock-hq.user.js
// ==/UserScript==
//
// How it works (see README.md for the long version):
//
//  * Twitch stitches ads into the HLS media playlist of each playback session. Other sessions for the same channel
//    share the exact same live segments and the same channel-wide sequence numbers (#EXT-X-TWITCH-LIVE-SEQUENCE).
//  * When the player's session shows an ad, this script opens backup sessions in parallel and uses the one that
//    offers *your* rendition (same resolution, frame rate, codec and bitrate) ad-free. A backup that receives its
//    own preroll is kept alive until that short preroll finishes, then used for the rest of the ad break.
//  * Segments from the player's session and the backups are merged into one continuous playlist keyed by the
//    channel-wide sequence number, so the player never sees ad segments, sequence jumps or duplicates and never
//    has to be reloaded.
//  * If no ad-free stream at your quality exists yet, it waits at full quality ('hold', default) or temporarily shows
//    the best lower quality ad-free stream ('lowres').
//
// Worker injection and React player lookup are adapted from TwitchAdSolutions
// (https://github.com/pixeltris/TwitchAdSolutions, MIT License, Copyright (c) 2020-present TwitchAdSolutions Contributors).

(function (root) {
    'use strict';

    const VERSION = '1.2.0';
    const MESSAGE_TAG = '__twitchAdBlockHQ';
    const SETTINGS_STORAGE_KEY = 'twitchAdBlockHQ.settings';

    const DEFAULT_SETTINGS = {
        // What to play while the player's session shows an ad and no ad-free stream at your quality exists yet:
        //   'lowres' - keep playing: show the best lower quality ad-free stream (usually 360p) for that short gap and
        //              switch back to your quality as soon as any session offers it ad-free
        //   'hold'   - never lower the quality; the player waits until an ad-free stream at your quality is available
        fallbackMode: 'lowres',
        // 'lowres' only: never show a fallback stream below this height in pixels (0 = no limit).
        minFallbackHeight: 0,
        // 'hold' only: pause the player while waiting, instead of showing a loading spinner. Off by default: restarting
        // Twitch's player after the pause can leave the video stuttering while audio plays (seen in Opera GX).
        pauseDuringHold: false,
        // 'hold' only: after a long wait, continue at the live edge (like Twitch after an ad) rather than where
        // playback stopped. Continuing where it stopped keeps every second of the stream but adds delay.
        resumeAtLiveEdge: true,
        // Keep backup sessions open between ads and check on them now and then, so any ad of their own is already over
        // when the next ad break starts. Makes a full quality backup available right away instead of after a gap.
        keepBackupsWarm: true,
        // Access token player types used for full quality backup sessions ('type' or 'type/platform'). All are
        // opened in parallel; the order only breaks ties.
        backupPlayerTypes: ['site', 'popout', 'mobile_web', 'embed'],
        // Player types used for the low quality fallback. Twitch keeps these (360p) streams ad-free.
        fallbackPlayerTypes: ['autoplay/android'],
        // Player type requested for the player's own session instead of 'site' (null = leave unchanged).
        forcePlayerType: 'popout',
        // Hide, mute and pause Twitch's separate video ads (beside the player and in chat) and stream display ads.
        // These are delivered outside the stream, so playlist handling can't remove them.
        hideDisplayAds: true,
        // Show a notice on the player while an ad is being blocked, and a clear "Ad break" screen while waiting.
        showBanner: true,
        // Log decisions to the console.
        debug: false,
        // Advanced: override values from TUNING below, e.g. { sessionWaitMs: 2000 }.
        tuning: {},
    };

    const TUNING = {
        sessionWaitMs: 3000, // How long a playlist request waits for backup sessions that are still opening
        mediaFetchTimeoutMs: 2500, // Timeout for backup media playlist requests
        pageFetchTimeoutMs: 5000, // Timeout for access token requests made through the page
        sessionRetryMs: 5000, // Delay before a failed backup session is opened again (doubles on repeated failures)
        sessionRetryMaxMs: 60000, // Longest delay between retries of a failing player type
        sessionLingerMs: 30000, // Keep backup sessions this long after an ad, in case ad markers come back
        sessionMaxAdMs: 90000, // Replace a backup session that has shown ads for this long
        sessionMaxAgeMs: 600000, // Replace backup sessions around this age, between ads (access tokens expire after ~20 min)
        warmStartDelayMs: 15000, // Open warm backup sessions this long after a stream starts, so they don't slow down its start
        warmPollMs: 10000, // How often warm backup sessions are checked between ads
        streamIdleMs: 60000, // Forget streams whose playlists have not been requested for this long
        maxTimelineSegments: 15, // Segments kept in rewritten playlists
        segmentsAfterGap: 3, // Segments added when playback resumes after skipped content (keeps latency low)
        skipToLiveAfterHoldMs: 6000, // After holding this long, resume at the live edge instead of where playback paused
        holdRefreshMs: 2000, // Playlist refresh interval while the player is paused for an ad
        maxHoldMs: 300000, // Stop refreshing on the player's behalf after this long
        holdPauseDelayMs: 1500, // Pause the player this long after a hold starts, before its quality selection reacts
    };

    // Public web client values, used until the page's own requests reveal the current ones.
    const DEFAULT_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    const DEFAULT_TOKEN_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';

    // -----------------------------------------------------------------------------------------------------------------
    // HLS playlist helpers. Pure functions: injected into the player's Web Worker and covered by the unit tests.
    // -----------------------------------------------------------------------------------------------------------------
    function createPlaylistLib() {
        function parseAttributes(text) {
            const attributes = {};
            const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const value = match[2];
                attributes[match[1]] = value.startsWith('"') ? value.slice(1, -1) : value;
            }
            return attributes;
        }

        function codecFamily(codecs) {
            const value = String(codecs || '').toLowerCase();
            if (/(^|,)\s*(hev1|hvc1)/.test(value)) return 'hevc';
            if (/(^|,)\s*av01/.test(value)) return 'av1';
            if (/(^|,)\s*avc[13]/.test(value)) return 'avc';
            if (/mp4a/.test(value)) return 'audio';
            return value.split('.')[0] || 'unknown';
        }

        function nextUriIndex(lines, start) {
            for (let i = start; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                if (!line.startsWith('#')) return i;
                if (line.startsWith('#EXTINF') || line.startsWith('#EXT-X-STREAM-INF')) return -1;
            }
            return -1;
        }

        function describeVariant(attributes, url) {
            const size = String(attributes.RESOLUTION || '').split('x');
            const width = parseInt(size[0], 10) || 0;
            const height = parseInt(size[1], 10) || 0;
            const fps = attributes['FRAME-RATE'] ? Math.round(parseFloat(attributes['FRAME-RATE'])) : 0;
            const codec = codecFamily(attributes.CODECS);
            const group = attributes.VIDEO || '';
            return {
                url,
                width,
                height,
                fps,
                codec,
                codecs: attributes.CODECS || '',
                bandwidth: parseInt(attributes.BANDWIDTH, 10) || 0,
                group,
                key: height ? `${width}x${height}@${fps}/${codec}` : `audio/${group || codec}`,
                label: height ? `${height}p${fps >= 48 ? fps : ''}` : 'audio only',
            };
        }

        function parseMaster(text) {
            const lines = String(text).replace(/\r/g, '').split('\n');
            const variants = [];
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
                const uriIndex = nextUriIndex(lines, i + 1);
                if (uriIndex < 0) continue;
                variants.push(describeVariant(parseAttributes(lines[i].slice(18)), lines[uriIndex].trim()));
            }
            return variants;
        }

        function qualityScore(variant) {
            return variant.height * 1000 + variant.fps;
        }

        // Finds the variant of another session to use for `target`: the identical rendition if it exists, otherwise
        // the best rendition that doesn't exceed the target and uses the same codec (the player can't switch codecs).
        function matchVariant(variants, target) {
            const exact = variants.find((v) => v.key === target.key && (!target.bandwidth || v.bandwidth >= target.bandwidth * 0.9));
            if (exact) {
                return { variant: exact, exact: true };
            }
            let best = null;
            for (const variant of variants) {
                if (!variant.height || !target.height || variant.codec !== target.codec) continue;
                if (qualityScore(variant) > qualityScore(target)) continue;
                if (!best || qualityScore(variant) > qualityScore(best) || (qualityScore(variant) === qualityScore(best) && variant.bandwidth > best.bandwidth)) {
                    best = variant;
                }
            }
            return best ? { variant: best, exact: false } : null;
        }

        // URL fragments of ad and placeholder segments, as observed in the field by TwitchAdSolutions.
        // Real segment URLs use a base64url token, so these slash-delimited fragments can't occur in them by chance.
        const AD_SEGMENT_URL_PATTERNS = ['/adsquared/', '/_404/', '/processing'];

        // twitch-stitched-ad, twitch-stitched-* variants, twitch-ad-quartile, twitch-maf-ad, ...
        function isAdDateRangeClass(className) {
            return /(^|-)ad(-|$)/.test(className) || className.includes('stitched');
        }

        function parseMedia(text, knownSequenceByUri) {
            const lines = String(text).replace(/\r/g, '').split('\n');
            const playlist = {
                mediaSequence: 0,
                liveSequence: null,
                targetDuration: 0,
                segments: [],
                prefetch: [],
                dateRanges: [],
                hasAdMarkers: false,
                endList: false,
            };
            let pdt = null;
            let discontinuity = false;
            let inCue = false; // Between SCTE-35 #EXT-X-CUE-OUT and #EXT-X-CUE-IN
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                if (line.startsWith('#EXTINF:')) {
                    const uriIndex = nextUriIndex(lines, i + 1);
                    if (uriIndex < 0) continue;
                    const comma = line.indexOf(',');
                    const durationText = comma < 0 ? line.slice(8) : line.slice(8, comma);
                    const title = comma < 0 ? '' : line.slice(comma + 1);
                    const uri = lines[uriIndex].trim();
                    const forcedAd = inCue || AD_SEGMENT_URL_PATTERNS.some((pattern) => uri.includes(pattern));
                    playlist.segments.push({
                        seq: playlist.mediaSequence + playlist.segments.length,
                        duration: parseFloat(durationText) || 0,
                        durationText,
                        title,
                        live: title.startsWith('live') && !forcedAd,
                        forcedAd,
                        uri,
                        pdt,
                        pdtMs: pdt ? Date.parse(pdt) : NaN,
                        discontinuity,
                        gseq: null,
                    });
                    pdt = null;
                    discontinuity = false;
                    i = uriIndex;
                } else if (line.startsWith('#EXT-X-CUE-OUT')) {
                    inCue = true;
                    playlist.hasAdMarkers = true;
                } else if (line.startsWith('#EXT-X-CUE-IN')) {
                    inCue = false;
                } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                    pdt = line.slice(25);
                } else if (line === '#EXT-X-DISCONTINUITY') {
                    discontinuity = true;
                } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                    playlist.mediaSequence = parseInt(line.slice(22), 10) || 0;
                } else if (line.startsWith('#EXT-X-TWITCH-LIVE-SEQUENCE:')) {
                    const value = parseInt(line.slice(28), 10);
                    playlist.liveSequence = Number.isFinite(value) ? value : null;
                } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                    playlist.targetDuration = parseInt(line.slice(22), 10) || 0;
                } else if (line.startsWith('#EXT-X-DATERANGE:')) {
                    const className = parseAttributes(line.slice(17)).CLASS || '';
                    if (isAdDateRangeClass(className) || line.includes('X-TV-TWITCH-AD') || line.includes('SCTE35-OUT')) {
                        playlist.hasAdMarkers = true;
                    }
                    playlist.dateRanges.push({ line, className });
                } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    playlist.prefetch.push(line.slice(23));
                } else if (line === '#EXT-X-ENDLIST') {
                    playlist.endList = true;
                }
            }
            if (!playlist.hasAdMarkers && !playlist.segments.some((s) => s.title.startsWith('live'))) {
                // Unknown segment titles and no ad markers: don't mistake the stream for an ad.
                playlist.segments.forEach((s) => { s.live = !s.forcedAd; });
            }
            assignGlobalSequence(playlist, knownSequenceByUri);
            return playlist;
        }

        // Numbers live segments with the channel-wide sequence. Sessions that showed an ad restart MEDIA-SEQUENCE at 0,
        // but #EXT-X-TWITCH-LIVE-SEQUENCE always holds the channel-wide number of the first live segment.
        function assignGlobalSequence(playlist, knownSequenceByUri) {
            let previous = null;
            let gap = false;
            for (const segment of playlist.segments) {
                if (!segment.live) {
                    gap = true;
                    continue;
                }
                const known = knownSequenceByUri ? knownSequenceByUri.get(segment.uri) : undefined;
                if (known !== undefined) {
                    segment.gseq = known;
                } else if (!previous) {
                    segment.gseq = playlist.liveSequence !== null ? playlist.liveSequence : segment.seq;
                } else if (!gap && !segment.discontinuity) {
                    segment.gseq = previous.gseq + 1;
                } else {
                    // Live segments on both sides of an ad: the ad occupies real time, so count the skipped segments.
                    const stepMs = (previous.duration || playlist.targetDuration || 2) * 1000;
                    const elapsedMs = segment.pdtMs - previous.pdtMs;
                    segment.gseq = previous.gseq + (Number.isFinite(elapsedMs) ? Math.max(1, Math.round(elapsedMs / stepMs)) : 1);
                }
                if (previous && segment.gseq <= previous.gseq) {
                    segment.gseq = previous.gseq + 1;
                }
                previous = segment;
                gap = false;
            }
        }

        function rememberSequence(knownSequenceByUri, playlist) {
            const current = new Set();
            for (const segment of playlist.segments) {
                if (segment.live && segment.gseq !== null) {
                    knownSequenceByUri.set(segment.uri, segment.gseq);
                    current.add(segment.uri);
                }
            }
            for (const uri of knownSequenceByUri.keys()) {
                if (knownSequenceByUri.size <= 64) break;
                if (!current.has(uri)) knownSequenceByUri.delete(uri);
            }
        }

        function hasAdSegments(playlist) {
            return playlist.segments.some((s) => !s.live);
        }

        function isShowingAd(playlist) {
            const last = playlist.segments[playlist.segments.length - 1];
            return last ? !last.live : playlist.hasAdMarkers;
        }

        function newestLiveSegment(playlist) {
            for (let i = playlist.segments.length - 1; i >= 0; i--) {
                if (playlist.segments[i].live) return playlist.segments[i];
            }
            return null;
        }

        // One timeline per variant playlist the player requests. `virtual` becomes true once the playlist is rewritten.
        function createTimeline() {
            return { segments: [], lastGseq: -1, pdtOffsets: {}, virtual: false, skipToLive: false, heldRefreshes: 0 };
        }

        // Sequence numbers shown to the player, shared by every variant of a stream so quality switches stay aligned.
        // They equal the channel-wide sequence until content is skipped (e.g. while holding during an ad); the gap is
        // then closed so the player sees contiguous numbers.
        function createSequenceState() {
            return { offset: 0, offsetSince: -1, lastGseq: -1, lastVseq: -1 };
        }

        // Adds live segments newer than the timeline's newest segment. Returns what changed.
        // After a gap only the newest `maxAfterGap` segments are added, so playback resumes close to live.
        function appendToTimeline(timeline, segments, variantKey, sourceId, sequence, maxAfterGap) {
            const result = { appended: 0, resumedAfterGap: false, switchedSource: false, changedRendition: false };
            let fresh = segments.filter((s) => s.live && s.gseq !== null && s.gseq > timeline.lastGseq
                && !(timeline.virtual && s.gseq < sequence.offsetSince)); // Older ones would reuse numbers from before a gap
            const newest = timeline.segments[timeline.segments.length - 1];
            if (maxAfterGap && newest && fresh.length > maxAfterGap && (fresh[0].gseq !== newest.gseq + 1 || timeline.skipToLive)) {
                fresh = fresh.slice(-maxAfterGap);
            }
            if (fresh.length) {
                timeline.skipToLive = false;
            }
            for (const segment of fresh) {
                if (timeline.virtual && sequence.lastGseq >= 0 && segment.gseq > sequence.lastGseq + 1) {
                    sequence.offset = sequence.lastVseq + 1 - segment.gseq;
                    sequence.offsetSince = segment.gseq;
                }
                const vseq = segment.gseq + sequence.offset;
                if (segment.gseq > sequence.lastGseq) {
                    sequence.lastGseq = segment.gseq;
                    sequence.lastVseq = vseq;
                }
                const previous = timeline.segments[timeline.segments.length - 1];
                const contiguous = !!previous && segment.gseq === previous.gseq + 1;
                const sameSource = !!previous && previous.sourceId === sourceId;
                const discontinuity = !!previous && (!contiguous || previous.variantKey !== variantKey || (sameSource && segment.discontinuity));
                if (previous && !contiguous) {
                    result.resumedAfterGap = true;
                }
                if (previous && !sameSource) {
                    result.switchedSource = true;
                }
                if (previous && previous.variantKey !== variantKey) {
                    result.changedRendition = true;
                }
                // Sessions label the same segment with slightly different times; keep the timeline's clock continuous.
                let pdtMs = segment.pdtMs;
                if (Number.isFinite(pdtMs)) {
                    if (previous && contiguous && !sameSource && Number.isFinite(previous.pdtMs)) {
                        timeline.pdtOffsets[sourceId] = previous.pdtMs + previous.duration * 1000 - segment.pdtMs;
                    } else if (!contiguous) {
                        timeline.pdtOffsets[sourceId] = 0;
                    }
                    pdtMs += timeline.pdtOffsets[sourceId] || 0;
                }
                if (previous && vseq !== previous.vseq + 1) {
                    // The player got the missing numbers from another variant. A playlist can't have holes, so start over.
                    timeline.segments.length = 0;
                }
                timeline.segments.push({
                    gseq: segment.gseq,
                    vseq,
                    duration: segment.duration,
                    durationText: segment.durationText,
                    uri: segment.uri,
                    pdtMs,
                    discontinuity,
                    discontinuityNumber: previous ? previous.discontinuityNumber + (discontinuity ? 1 : 0) : 0,
                    variantKey,
                    sourceId,
                });
                timeline.lastGseq = segment.gseq;
                result.appended++;
            }
            return result;
        }

        function trimTimeline(timeline, maxSegments) {
            if (timeline.segments.length > maxSegments) {
                timeline.segments.splice(0, timeline.segments.length - maxSegments);
            }
        }

        function renderTimeline(timeline, options) {
            const opts = options || {};
            const segments = timeline.segments;
            const first = segments[0];
            let targetDuration = opts.targetDuration || 0;
            for (const segment of segments) {
                targetDuration = Math.max(targetDuration, Math.ceil(segment.duration));
            }
            const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${targetDuration || 6}`];
            lines.push(`#EXT-X-MEDIA-SEQUENCE:${first ? first.vseq : Math.max(0, opts.nextSequence || 0)}`);
            if (first) {
                lines.push(`#EXT-X-TWITCH-LIVE-SEQUENCE:${first.vseq}`);
                const discontinuitySequence = first.discontinuityNumber - (first.discontinuity ? 1 : 0);
                if (discontinuitySequence > 0) {
                    lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`);
                }
            }
            for (const line of opts.headerLines || []) {
                lines.push(line);
            }
            for (const segment of segments) {
                if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
                if (Number.isFinite(segment.pdtMs)) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.pdtMs).toISOString()}`);
                lines.push(`#EXTINF:${segment.durationText},live`);
                lines.push(segment.uri);
            }
            for (const uri of opts.prefetch || []) {
                lines.push(`#EXT-X-TWITCH-PREFETCH:${uri}`);
            }
            if (opts.endList) lines.push('#EXT-X-ENDLIST');
            return lines.join('\n') + '\n';
        }

        return {
            parseAttributes,
            codecFamily,
            parseMaster,
            parseMedia,
            matchVariant,
            qualityScore,
            rememberSequence,
            hasAdSegments,
            isShowingAd,
            newestLiveSegment,
            createTimeline,
            createSequenceState,
            appendToTimeline,
            trimTimeline,
            renderTimeline,
        };
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Runs inside the player's Web Worker (before Twitch's own worker code). `scope` is the worker global scope.
    // -----------------------------------------------------------------------------------------------------------------
    function workerMain(init, scope, createLib) {
        const Lib = createLib();
        const realFetch = scope.fetch.bind(scope);
        const tag = init.messageTag;
        let settings = init.settings;
        let tuning = Object.assign({}, init.tuning, settings.tuning);
        const gql = Object.assign({}, init.gql);
        const streams = new Map();
        const mainPlaylists = new Map(); // player's media playlist URL -> { stream, variant, timeline, memo }
        const pendingPageFetches = new Map();
        let simulation = { until: 0, includeBackups: false };
        let nextId = 1;

        const now = () => Date.now();
        const log = (...args) => {
            if (settings.debug) console.log('[TwitchAdBlockHQ]', ...args);
        };
        const post = (message) => scope.postMessage(Object.assign({ [tag]: true }, message));

        scope.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data[tag] !== true) return;
            event.stopImmediatePropagation();
            if (data.type === 'gql') {
                Object.assign(gql, data.value);
            } else if (data.type === 'settings') {
                settings = data.value;
                tuning = Object.assign({}, init.tuning, settings.tuning);
            } else if (data.type === 'simulate-ad') {
                simulation = { until: now() + data.seconds * 1000, includeBackups: !!data.includeBackups };
                log('simulating ad for', data.seconds, 's', data.includeBackups ? '(including backups)' : '');
            } else if (data.type === 'page-fetch-result') {
                const resolve = pendingPageFetches.get(data.id);
                if (resolve) {
                    pendingPageFetches.delete(data.id);
                    resolve(data.value);
                }
            }
        });

        scope.fetch = function (input, options) {
            let url = null;
            try {
                url = (typeof input === 'string' ? input : (input && input.url) || String(input)).trim();
            } catch (err) {
                url = null;
            }
            if (url) {
                if (isUsherUrl(url)) {
                    return handleMaster(url, input, options);
                }
                const entry = mainPlaylists.get(url);
                if (entry) {
                    return handleMedia(entry, input, options);
                }
            }
            return realFetch(input, options);
        };
        Object.defineProperty(scope.fetch, 'toString', { value: () => 'function fetch() { [native code] }', configurable: true });

        function isUsherUrl(url) {
            return /\/channel\/hls\/[^/?]+\.m3u8/.test(url) && !url.includes('picture-by-picture');
        }

        function playlistResponse(text) {
            return new Response(text, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
        }

        function withTimeout(promise, ms) {
            return new Promise((resolve) => {
                const timer = setTimeout(() => resolve(null), ms);
                promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
            });
        }

        function pageFetch(url, options) {
            return new Promise((resolve) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                    pendingPageFetches.delete(id);
                    resolve({ error: 'timeout' });
                }, tuning.pageFetchTimeoutMs);
                pendingPageFetches.set(id, (value) => {
                    clearTimeout(timer);
                    resolve(value);
                });
                post({ type: 'page-fetch', id, url, options });
            });
        }

        async function handleMaster(url, input, options) {
            let requestUrl = url;
            if (settings.forcePlayerType) {
                // parent_domains marks the player as embedded, which attracts extra ads.
                const parsed = new URL(url);
                if (parsed.searchParams.has('parent_domains')) {
                    parsed.searchParams.delete('parent_domains');
                    requestUrl = parsed.href;
                }
            }
            const response = await realFetch(requestUrl === url ? input : requestUrl, options);
            if (response.status !== 200) return response;
            const text = await response.text();
            try {
                registerStream(requestUrl, text);
            } catch (err) {
                console.warn('[TwitchAdBlockHQ] failed to read master playlist', err);
            }
            return playlistResponse(text);
        }

        function registerStream(url, text) {
            const usherUrl = new URL(url);
            const variants = Lib.parseMaster(text);
            if (!variants.length) return;
            const channel = decodeURIComponent(usherUrl.pathname.split('/').pop().replace(/\.m3u8$/, '')).toLowerCase();
            const stream = {
                id: nextId++, channel, usherUrl, variants, sessions: new Map(), failures: new Map(), cleanSince: 0, lastVariant: null, warmTimer: null,
                sequence: Lib.createSequenceState(), lastRequestAt: now(), adActive: false, statusKey: null,
            };
            streams.set(stream.id, stream);
            for (const variant of variants) {
                mainPlaylists.set(variant.url, { stream, variant, timeline: Lib.createTimeline(), memo: new Map(), source: null });
            }
            pruneStreams(stream);
            log(`stream ${channel}: ${variants.map((v) => v.label).join(', ')}`);
        }

        function pruneStreams(keep) {
            for (const stream of streams.values()) {
                if (stream === keep || now() - stream.lastRequestAt < tuning.streamIdleMs) continue;
                streams.delete(stream.id);
                for (const [url, entry] of mainPlaylists) {
                    if (entry.stream === stream) mainPlaylists.delete(url);
                }
            }
        }

        async function handleMedia(entry, input, options) {
            entry.lastPlayerRequestAt = entry.stream.lastRequestAt = now();
            const response = await realFetch(input, options);
            if (response.status !== 200) return response;
            const text = await response.text();
            try {
                return playlistResponse(await processMediaPlaylist(entry, text));
            } catch (err) {
                console.warn('[TwitchAdBlockHQ] failed to process media playlist', err);
                return playlistResponse(text);
            }
        }

        // While holding, the page pauses the player, which stops its playlist requests. Keep refreshing the playlist
        // ourselves so the page learns as soon as playback can continue.
        function keepRefreshingWhileHolding(entry) {
            if (entry.holdTimer) return;
            const startedAt = now();
            entry.holdTimer = setInterval(async () => {
                if (!entry.holding || !mainPlaylists.has(entry.variant.url) || now() - startedAt > tuning.maxHoldMs) {
                    clearInterval(entry.holdTimer);
                    entry.holdTimer = null;
                    return;
                }
                if (entry.refreshing || now() - entry.lastPlayerRequestAt < tuning.holdRefreshMs) return;
                entry.refreshing = true;
                try {
                    const response = await realFetch(entry.variant.url);
                    if (response.status === 200) await processMediaPlaylist(entry, await response.text());
                } catch (err) {
                    log('refresh while holding failed', err);
                } finally {
                    entry.refreshing = false;
                }
            }, tuning.holdRefreshMs);
            if (entry.holdTimer && typeof entry.holdTimer.unref === 'function') entry.holdTimer.unref();
        }

        async function processMediaPlaylist(entry, text) {
            const { stream, variant, timeline } = entry;
            stream.lastVariant = variant;
            keepSessionsWarm(stream);
            const simulating = simulation.until > now();
            const main = Lib.parseMedia(text, entry.memo);
            Lib.rememberSequence(entry.memo, main);
            const mainShowingAd = simulating || Lib.isShowingAd(main);
            const mainClean = !simulating && !main.hasAdMarkers && !Lib.hasAdSegments(main);
            if (!mainClean) stream.cleanSince = 0;
            // Sessions that showed an ad number their segments from 0; those always need rewriting.
            const numberedGlobally = main.segments.length > 0 && main.segments[0].gseq === main.segments[0].seq;

            if (!timeline.virtual && mainClean && numberedGlobally && stream.sequence.offset === 0) {
                // Nothing to do: return Twitch's playlist untouched, but track it so a later switch is seamless.
                Lib.appendToTimeline(timeline, main.segments, variant.key, 'main', stream.sequence);
                Lib.trimTimeline(timeline, tuning.maxTimelineSegments);
                releaseIdleSessions(stream);
                reportStatus(stream, { adActive: false });
                return text;
            }
            timeline.virtual = true;

            let source = null;
            if (mainShowingAd) {
                source = await pickBackup(stream, variant, entry.source && entry.source.id);
            } else {
                // The ad is over. Leave a full quality backup only once the player's session is completely clean,
                // otherwise switch back right away.
                const onFullQualityBackup = entry.source && entry.source.id !== 'main' && entry.source.exact;
                if (onFullQualityBackup && !mainClean) {
                    source = await pickBackup(stream, variant, entry.source.id);
                    if (source && !source.exact) source = null;
                }
                if (!source) {
                    // Also covers breaks where Twitch only announces the ad (markers) while every segment stays live:
                    // the main session is played at full quality and the markers are left out of the playlist.
                    source = { id: 'main', label: 'main', variant, exact: true, playlist: main };
                }
            }

            entry.holding = !source;
            if (source) {
                timeline.heldSince = 0;
            } else {
                keepRefreshingWhileHolding(entry);
                if (!timeline.heldSince) {
                    timeline.heldSince = now();
                } else if (settings.resumeAtLiveEdge !== false && now() - timeline.heldSince > tuning.skipToLiveAfterHoldMs) {
                    timeline.skipToLive = true; // Like Twitch after an ad: continue at the live edge instead of replaying the pause
                }
            }
            const change = source ? Lib.appendToTimeline(timeline, source.playlist.segments, source.variant.key, source.id, stream.sequence, tuning.segmentsAfterGap) : { appended: 0 };
            Lib.trimTimeline(timeline, tuning.maxTimelineSegments);
            if (source) {
                if (!entry.source || entry.source.id !== source.id) {
                    log(`${stream.channel} ${variant.label}: using ${source.label} (${source.variant.label})`);
                }
                entry.source = source;
            }
            if (mainClean && (!entry.source || entry.source.id === 'main')) {
                releaseIdleSessions(stream);
            }

            // Low latency prefetch hints are only passed on from an ad-free source whose live edge we're at.
            const sourceNewest = source && Lib.newestLiveSegment(source.playlist);
            const sourceClean = source && (source.id === 'main' ? mainClean : !source.playlist.hasAdMarkers && !Lib.hasAdSegments(source.playlist));
            const prefetch = sourceClean && sourceNewest && sourceNewest.gseq === timeline.lastGseq ? source.playlist.prefetch : [];
            const usingBackup = !!source && source.id !== 'main';
            reportStatus(stream, {
                adActive: mainShowingAd || usingBackup,
                mode: !source ? 'hold' : usingBackup ? (source.exact ? 'backup' : 'lowres') : 'main',
                quality: variant.label,
                sourceQuality: source ? source.variant.label : null,
                source: source ? source.label : null,
                resumedAfterGap: !!change.resumedAfterGap,
                changedRendition: !!change.changedRendition,
            });

            if (settings.debug && timeline.segments.length) {
                const last = timeline.segments[timeline.segments.length - 1];
                log(`${stream.channel} ${variant.label}: ${source ? source.label : 'hold'} +${change.appended}, player sequence ${timeline.segments[0].vseq}-${last.vseq}${change.resumedAfterGap ? ' (after gap)' : ''}`);
            }
            const sourcePlaylist = source ? source.playlist : main;
            return Lib.renderTimeline(timeline, {
                targetDuration: main.targetDuration,
                nextSequence: stream.sequence.lastVseq + 1,
                headerLines: sourcePlaylist.dateRanges.filter((d) => d.className === 'timestamp' || d.className === 'twitch-session').map((d) => d.line),
                prefetch,
                endList: main.endList,
            });
        }

        function candidates() {
            const list = [];
            const add = (entry, kind, order) => {
                const [playerType, platform] = String(entry).split('/');
                if (!playerType) return;
                const resolvedPlatform = platform || (playerType === 'autoplay' ? 'android' : 'web');
                list.push({ key: `${kind}:${playerType}/${resolvedPlatform}`, label: playerType, playerType, platform: resolvedPlatform, kind, order });
            };
            (settings.backupPlayerTypes || []).forEach((entry, i) => add(entry, 'full', i));
            if (settings.fallbackMode === 'lowres') {
                (settings.fallbackPlayerTypes || []).forEach((entry, i) => add(entry, 'fallback', 100 + i));
            }
            return list;
        }

        function ensureSessions(stream) {
            const time = now();
            for (const candidate of candidates()) {
                const session = stream.sessions.get(candidate.key);
                const failure = stream.failures.get(candidate.key);
                // A player type that keeps failing (e.g. GQL "server error") is retried less and less often.
                const coolingDown = failure && time - failure.at < Math.min(tuning.sessionRetryMs * 2 ** (failure.count - 1), tuning.sessionRetryMaxMs);
                // Warm sessions are renewed gracefully before this; this only replaces sessions close to token expiry.
                const replace = !session
                    || session.state === 'failed'
                    || (session.adSince && time - session.adSince > tuning.sessionMaxAdMs)
                    || time - session.createdAt > tuning.sessionMaxAgeMs * 1.8;
                if (replace && !coolingDown) {
                    stream.sessions.set(candidate.key, openSession(stream, candidate));
                }
            }
        }

        function markSessionFailed(stream, session, reason) {
            session.state = 'failed';
            const failure = stream.failures.get(session.key) || { count: 0, at: 0 };
            failure.count++;
            failure.at = now();
            stream.failures.set(session.key, failure);
            log(`backup ${session.key} failed (${failure.count}x): ${reason}`);
        }

        // Backup sessions are kept for a while after an ad: Twitch sometimes shows ad markers again moments later.
        function releaseIdleSessions(stream) {
            if (settings.keepBackupsWarm || !stream.sessions.size) return;
            if (!stream.cleanSince) {
                stream.cleanSince = now();
            } else if (now() - stream.cleanSince >= tuning.sessionLingerMs) {
                stream.sessions.clear();
            }
        }

        // Between ads, keep backup sessions open and look at them now and then: any ad of their own runs out in the
        // meantime, so a full quality backup is ready the moment the player's session shows an ad.
        function keepSessionsWarm(stream) {
            if (!settings.keepBackupsWarm || stream.warmTimer) return;
            const startAt = now() + tuning.warmStartDelayMs;
            stream.warmTimer = setInterval(() => {
                if (!streams.has(stream.id) || !settings.keepBackupsWarm || now() - stream.lastRequestAt > tuning.streamIdleMs) {
                    clearInterval(stream.warmTimer);
                    stream.warmTimer = null;
                    return;
                }
                if (now() < startAt || stream.adActive || stream.warming) return;
                stream.warming = true;
                warmSessions(stream)
                    .catch((err) => log('keeping backup sessions warm failed', err))
                    .then(() => { stream.warming = false; });
            }, tuning.warmPollMs);
            if (typeof stream.warmTimer.unref === 'function') stream.warmTimer.unref();
        }

        async function warmSessions(stream) {
            ensureSessions(stream);
            const target = stream.lastVariant;
            if (!target) return;
            const polls = [];
            for (const [key, session] of stream.sessions) {
                if (session.successor && session.successor.state === 'failed') session.successor = null;
                // Renew before the access token expires. The old session stays in use until its successor is ad-free.
                if (session.state === 'ready' && !session.successor && now() - session.createdAt > session.renewAfterMs) {
                    session.successor = openSession(stream, session.candidate);
                }
                for (const current of [session, session.successor]) {
                    if (!current || current.state !== 'ready') continue;
                    const match = Lib.matchVariant(current.variants, target);
                    if (match) polls.push(pollSession(stream, current, match).then((result) => ({ key, current, result })));
                }
            }
            for (const { key, current, result } of await Promise.all(polls)) {
                const session = stream.sessions.get(key);
                if (session && session.successor === current && result && !result.showingAd && result.newest) {
                    stream.sessions.set(key, current);
                    log(`backup ${key} renewed`);
                }
            }
        }

        function openSession(stream, candidate) {
            const session = Object.assign({
                state: 'opening', createdAt: now(), variants: [], memos: new Map(), adSince: null, candidate,
                renewAfterMs: tuning.sessionMaxAgeMs * (0.8 + Math.random() * 0.4),
            }, candidate);
            session.ready = (async () => {
                const token = await requestAccessToken(stream.channel, candidate.playerType, candidate.platform);
                const usherUrl = new URL(stream.usherUrl.href);
                usherUrl.searchParams.set('sig', token.signature);
                usherUrl.searchParams.set('token', token.value);
                usherUrl.searchParams.set('p', String(Math.floor(Math.random() * 10000000)));
                usherUrl.searchParams.delete('parent_domains');
                if (usherUrl.searchParams.has('play_session_id')) {
                    usherUrl.searchParams.set('play_session_id', randomHex(32));
                }
                const response = await realFetch(usherUrl.href);
                if (response.status !== 200) throw new Error(`usher HTTP ${response.status}`);
                session.variants = Lib.parseMaster(await response.text());
                if (!session.variants.length) throw new Error('no variants');
                session.state = 'ready';
                stream.failures.delete(session.key);
                log(`backup ${session.key} ready: ${session.variants.map((v) => v.label).join(', ')}`);
            })().catch((err) => {
                markSessionFailed(stream, session, err && err.message ? err.message : err);
            });
            return session;
        }

        function randomHex(length) {
            let value = '';
            while (value.length < length) value += Math.floor(Math.random() * 16).toString(16);
            return value;
        }

        async function requestAccessToken(login, playerType, platform) {
            const variables = Object.assign({}, gql.tokenVariables || {}, { isLive: true, login, isVod: false, vodID: '', playerType, platform });
            const body = { operationName: gql.tokenOperationName || 'PlaybackAccessToken', variables };
            if (gql.tokenHash || !gql.tokenQuery) {
                body.extensions = { persistedQuery: { version: 1, sha256Hash: gql.tokenHash || init.defaults.tokenHash } };
            } else {
                body.query = gql.tokenQuery;
            }
            const headers = { 'Client-ID': gql.clientId || init.defaults.clientId };
            if (gql.deviceId) headers['X-Device-Id'] = gql.deviceId;
            if (gql.authorization) headers.Authorization = gql.authorization;
            if (gql.integrity) headers['Client-Integrity'] = gql.integrity;
            if (gql.clientVersion) headers['Client-Version'] = gql.clientVersion;
            if (gql.clientSession) headers['Client-Session-Id'] = gql.clientSession;
            const result = await pageFetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: JSON.stringify(body) });
            if (result.error || result.status !== 200) throw new Error(`token ${result.error || 'HTTP ' + result.status}`);
            const json = JSON.parse(result.body);
            const token = json && json.data && json.data.streamPlaybackAccessToken;
            if (!token || !token.value || !token.signature) {
                throw new Error(`token missing: ${String(result.body).slice(0, 300)}`);
            }
            return token;
        }

        // Polls every backup session (which also lets their own prerolls run out) and returns the best ad-free source
        // for `target`, or null when nothing acceptable is available.
        async function pickBackup(stream, target, preferId) {
            ensureSessions(stream);
            const opening = [...stream.sessions.values()].filter((s) => s.state === 'opening').map((s) => s.ready);
            if (opening.length) {
                await withTimeout(Promise.all(opening), tuning.sessionWaitMs);
            }
            const polls = [];
            for (const session of stream.sessions.values()) {
                if (session.state !== 'ready') continue;
                const match = Lib.matchVariant(session.variants, target);
                if (match) polls.push(pollSession(stream, session, match));
            }
            const simulatingBackups = simulation.includeBackups && simulation.until > now();
            const usable = (await Promise.all(polls)).filter((r) => r && !r.showingAd && r.newest && !(simulatingBackups && r.kind === 'full'));
            const allowLower = settings.fallbackMode === 'lowres';
            const acceptable = usable.filter((r) => r.exact || (allowLower && r.variant.height >= (settings.minFallbackHeight || 0)));
            acceptable.sort((a, b) => (b.exact - a.exact)
                || (Lib.qualityScore(b.variant) - Lib.qualityScore(a.variant))
                || ((b.id === preferId) - (a.id === preferId))
                || (b.newest.gseq - a.newest.gseq)
                || (a.order - b.order));
            return acceptable[0] || null;
        }

        async function pollSession(stream, session, match) {
            const response = await withTimeout(realFetch(match.variant.url), tuning.mediaFetchTimeoutMs);
            if (!response) return null;
            if (response.status !== 200) {
                if (response.status === 403 || response.status === 404) markSessionFailed(stream, session, `playlist HTTP ${response.status}`);
                return null;
            }
            const text = await withTimeout(response.text(), tuning.mediaFetchTimeoutMs);
            if (text === null) return null;
            let memo = session.memos.get(match.variant.url);
            if (!memo) {
                memo = new Map();
                session.memos.set(match.variant.url, memo);
            }
            const playlist = Lib.parseMedia(text, memo);
            Lib.rememberSequence(memo, playlist);
            const showingAd = Lib.isShowingAd(playlist);
            session.adSince = showingAd ? session.adSince || now() : null;
            return {
                id: session.key,
                label: session.label,
                kind: session.kind,
                order: session.order,
                variant: match.variant,
                exact: match.exact,
                playlist,
                showingAd,
                newest: Lib.newestLiveSegment(playlist),
            };
        }

        function reportStatus(stream, status) {
            const full = Object.assign({ channel: stream.channel, adActive: false, mode: null, quality: null, sourceQuality: null, source: null, resumedAfterGap: false, changedRendition: false }, status);
            const disrupted = full.resumedAfterGap || full.changedRendition;
            const key = JSON.stringify(Object.assign({}, full, { resumedAfterGap: false, changedRendition: false }));
            if (key === stream.statusKey && !disrupted) return;
            stream.statusKey = key;
            if (full.adActive !== stream.adActive) {
                stream.adActive = full.adActive;
                log(full.adActive ? `${stream.channel}: ad detected (${full.mode})` : `${stream.channel}: ad finished`);
            }
            post({ type: 'status', status: full });
        }

        log('worker hooks installed');
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Page side
    // -----------------------------------------------------------------------------------------------------------------
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        module.exports = { createPlaylistLib, workerMain, DEFAULT_SETTINGS, TUNING };
        return;
    }
    // Twitch pages contain several hidden auxiliary iframes. Only the top page and Twitch's embed player host a stream.
    let nestedFrame = true;
    try {
        nestedFrame = root.top !== root;
    } catch (err) {
        // Treat an inaccessible parent as nested.
    }
    if (nestedFrame && !/^(player|embed)\.twitch\.tv$/.test(root.location.hostname) && !root.location.pathname.startsWith('/embed/')) {
        return;
    }
    if (root[MESSAGE_TAG]) {
        return;
    }
    root[MESSAGE_TAG] = VERSION;

    const realFetch = root.fetch;
    const workers = new Set();
    const gqlContext = {};
    let settings = loadSettings();
    let lastStatus = null;

    if (typeof root.twitchAdSolutionsVersion !== 'undefined') {
        console.warn('[TwitchAdBlockHQ] Another Twitch ad blocking script (TwitchAdSolutions) is active. Use only one of them.');
    }

    function loadSettings() {
        try {
            const stored = JSON.parse(root.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
            const migrated = migrateLegacySettings(stored);
            const loaded = sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, migrated || stored));
            if (migrated) saveSettings(loaded);
            return loaded;
        } catch (err) {
            return Object.assign({}, DEFAULT_SETTINGS);
        }
    }

    // Up to version 1.1.3 every setting was stored, which would keep the defaults of that time forever. Such a full copy
    // has every setting those versions knew; values that were defaults back then are dropped, once.
    function migrateLegacySettings(stored) {
        const legacyKeys = ['fallbackMode', 'minFallbackHeight', 'backupPlayerTypes', 'fallbackPlayerTypes', 'forcePlayerType', 'showBanner', 'debug'];
        const legacyDefaults = { fallbackMode: ['hold'], pauseDuringHold: [true, false], backupPlayerTypes: [['embed', 'site', 'popout']] };
        if (!legacyKeys.every((key) => key in stored)) return null;
        const result = Object.assign({}, stored);
        for (const [key, values] of Object.entries(legacyDefaults)) {
            if (values.some((value) => JSON.stringify(value) === JSON.stringify(result[key]))) delete result[key];
        }
        return result;
    }

    function effectiveTuning() {
        return Object.assign({}, TUNING, settings.tuning);
    }

    function sanitizeSettings(value) {
        const result = Object.assign({}, DEFAULT_SETTINGS);
        if (value.fallbackMode === 'hold' || value.fallbackMode === 'lowres') result.fallbackMode = value.fallbackMode;
        if (Number.isFinite(value.minFallbackHeight) && value.minFallbackHeight >= 0) result.minFallbackHeight = value.minFallbackHeight;
        if (Array.isArray(value.backupPlayerTypes)) result.backupPlayerTypes = value.backupPlayerTypes.map(String).filter(Boolean);
        if (Array.isArray(value.fallbackPlayerTypes)) result.fallbackPlayerTypes = value.fallbackPlayerTypes.map(String).filter(Boolean);
        if (value.forcePlayerType === null || typeof value.forcePlayerType === 'string') result.forcePlayerType = value.forcePlayerType || null;
        for (const key of ['pauseDuringHold', 'resumeAtLiveEdge', 'keepBackupsWarm', 'hideDisplayAds', 'showBanner', 'debug']) {
            if (typeof value[key] === 'boolean') result[key] = value[key];
        }
        result.tuning = {};
        for (const [key, number] of Object.entries(value.tuning || {})) {
            if (Object.prototype.hasOwnProperty.call(TUNING, key) && Number.isFinite(number) && number >= 0) result.tuning[key] = number;
        }
        return result;
    }

    // Only settings that differ from the defaults are stored, so improved defaults reach everyone else.
    function saveSettings(value = settings) {
        const changed = {};
        for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
            if (JSON.stringify(value[key]) !== JSON.stringify(defaultValue)) changed[key] = value[key];
        }
        try {
            if (Object.keys(changed).length) {
                root.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(changed));
            } else {
                root.localStorage.removeItem(SETTINGS_STORAGE_KEY);
            }
        } catch (err) {
            console.warn('[TwitchAdBlockHQ] could not save settings', err);
        }
    }

    function broadcast(message) {
        for (const worker of workers) {
            worker.postMessage(Object.assign({ [MESSAGE_TAG]: true }, message));
        }
    }

    function readHeader(headers, name) {
        if (!headers) return null;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name);
        const wanted = name.toLowerCase();
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === wanted) return headers[key];
        }
        return null;
    }

    // Hooks look like the browser's own functions to page code that inspects them.
    function maskAsNative(fn, name) {
        Object.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true });
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
        return fn;
    }

    // Debug aid: client-side ad requests are delivered outside the stream and can't be handled via playlists.
    const clientAdRequests = {};
    function noteClientAdRequest(url) {
        if (!settings.debug || !String(url).includes('edge.ads.twitch.tv')) return;
        const type = /[?&]bp=(\w+)/.exec(url);
        const key = type ? type[1] : 'unknown';
        clientAdRequests[key] = (clientAdRequests[key] || 0) + 1;
        if (clientAdRequests[key] === 1 || clientAdRequests[key] % 10 === 0) {
            console.log(`[TwitchAdBlockHQ] client-side ad request (${key}) #${clientAdRequests[key]}, stream ad blocking active: ${!!(lastStatus && lastStatus.adActive)}`);
        }
    }

    function hookFetch() {
        root.fetch = maskAsNative(function (input, init) {
            try {
                const url = typeof input === 'string' ? input : input && input.url;
                noteClientAdRequest(url);
                if (url && url.startsWith('https://gql.twitch.tv/') && init) {
                    captureGqlContext(init);
                    if (typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        const body = rewriteAccessTokenRequest(init.body);
                        if (body !== init.body) {
                            return realFetch.call(this, input, Object.assign({}, init, { body }));
                        }
                    }
                }
            } catch (err) {
                console.warn('[TwitchAdBlockHQ] fetch hook error', err);
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
        if (settings.debug) {
            const realOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = maskAsNative(function (method, url) {
                noteClientAdRequest(url);
                return realOpen.apply(this, arguments);
            }, 'open');
        }
    }

    function captureGqlContext(init) {
        const update = {
            clientId: readHeader(init.headers, 'Client-ID'),
            deviceId: readHeader(init.headers, 'X-Device-Id') || readHeader(init.headers, 'Device-ID'),
            authorization: readHeader(init.headers, 'Authorization'),
            integrity: readHeader(init.headers, 'Client-Integrity'),
            clientVersion: readHeader(init.headers, 'Client-Version'),
            clientSession: readHeader(init.headers, 'Client-Session-Id'),
        };
        let changed = false;
        for (const [key, value] of Object.entries(update)) {
            if (typeof value === 'string' && value && value !== 'undefined' && gqlContext[key] !== value) {
                gqlContext[key] = value;
                changed = true;
            }
        }
        if (changed) broadcast({ type: 'gql', value: Object.assign({}, gqlContext) });
    }

    function rewriteAccessTokenRequest(bodyText) {
        let body;
        try {
            body = JSON.parse(bodyText);
        } catch (err) {
            return bodyText;
        }
        let changed = false;
        for (const operation of Array.isArray(body) ? body : [body]) {
            if (!operation || !operation.variables || !String(operation.operationName).startsWith('PlaybackAccessToken') || !operation.variables.isLive) continue;
            const hash = operation.extensions && operation.extensions.persistedQuery && operation.extensions.persistedQuery.sha256Hash;
            if ((hash && hash !== gqlContext.tokenHash) || (!hash && operation.query && operation.query !== gqlContext.tokenQuery)) {
                gqlContext.tokenOperationName = operation.operationName;
                gqlContext.tokenHash = hash || null;
                gqlContext.tokenQuery = hash ? null : operation.query;
                gqlContext.tokenVariables = Object.assign({}, operation.variables);
                broadcast({ type: 'gql', value: Object.assign({}, gqlContext) });
            }
            if (settings.forcePlayerType && operation.variables.playerType === 'site') {
                operation.variables.playerType = settings.forcePlayerType;
                changed = true;
            }
        }
        return changed ? JSON.stringify(body) : bodyText;
    }

    function hookWorker() {
        const BaseWorker = root.Worker;
        if (typeof BaseWorker !== 'function') return;

        class TwitchAdBlockWorker extends BaseWorker {
            constructor(scriptURL, options) {
                let source = null;
                if (isTwitchWorkerUrl(scriptURL)) {
                    try {
                        source = loadWorkerSource(scriptURL);
                    } catch (err) {
                        console.warn('[TwitchAdBlockHQ] could not read the player worker', err);
                    }
                }
                if (source === null) {
                    super(scriptURL, options);
                    return;
                }
                if (source.includes(MESSAGE_TAG)) {
                    // Already carries our hooks (e.g. another Worker wrapper passed our blob through): don't hook twice.
                    super(scriptURL, options);
                    attachWorker(this);
                    return;
                }
                const blobUrl = URL.createObjectURL(new Blob([buildWorkerSource(source)], { type: 'text/javascript' }));
                super(blobUrl, options);
                attachWorker(this);
                // Free the blob once the worker is running.
                const revoke = () => URL.revokeObjectURL(blobUrl);
                this.addEventListener('message', revoke, { once: true });
                setTimeout(revoke, 30000);
            }

            terminate() {
                workers.delete(this);
                super.terminate();
            }
        }

        maskAsNative(TwitchAdBlockWorker, 'Worker');
        Object.defineProperty(root, 'Worker', {
            configurable: true,
            get() {
                return TwitchAdBlockWorker;
            },
            set(value) {
                // Another script wrapped Worker after us: keep our hook on top and let theirs run underneath.
                if (typeof value === 'function' && value !== TwitchAdBlockWorker) {
                    Object.setPrototypeOf(TwitchAdBlockWorker, value);
                    Object.setPrototypeOf(TwitchAdBlockWorker.prototype, value.prototype);
                }
            },
        });
    }

    function isTwitchWorkerUrl(scriptURL) {
        try {
            return new URL(String(scriptURL), root.location.href).origin.endsWith('twitch.tv');
        } catch (err) {
            return false;
        }
    }

    function loadWorkerSource(scriptURL) {
        const request = new XMLHttpRequest();
        request.open('GET', String(scriptURL), false);
        request.overrideMimeType('text/javascript');
        request.send();
        if (request.status !== 200 && request.status !== 0) throw new Error(`HTTP ${request.status}`);
        return request.responseText;
    }

    function buildWorkerSource(twitchSource) {
        const init = { messageTag: MESSAGE_TAG, settings, tuning: TUNING, gql: gqlContext, defaults: { clientId: DEFAULT_CLIENT_ID, tokenHash: DEFAULT_TOKEN_HASH } };
        const prelude = `(function () {\n'use strict';\n(${workerMain.toString()})(${JSON.stringify(init)}, self, ${createPlaylistLib.toString()});\n})();\n`;
        // Keep a leading "use strict" directive of Twitch's worker in first position.
        const directive = /^\s*(['"])use strict\1;?/.exec(twitchSource);
        return directive ? `${directive[0]}\n${prelude}${twitchSource.slice(directive[0].length)}` : prelude + twitchSource;
    }

    function attachWorker(worker) {
        workers.add(worker);
        worker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data[MESSAGE_TAG] !== true) return;
            event.stopImmediatePropagation();
            if (data.type === 'page-fetch') {
                handleWorkerPageFetch(worker, data);
            } else if (data.type === 'status') {
                onStatus(data.status);
            }
        });
    }

    async function handleWorkerPageFetch(worker, data) {
        let value;
        try {
            if (!String(data.url).startsWith('https://gql.twitch.tv/')) throw new Error('not allowed');
            const response = await realFetch.call(root, data.url, data.options);
            value = { status: response.status, body: await response.text() };
        } catch (err) {
            value = { error: String(err && err.message ? err.message : err) };
        }
        worker.postMessage({ [MESSAGE_TAG]: true, type: 'page-fetch-result', id: data.id, value });
    }

    // Recent decisions and actions, for twitchAdBlockHQ.diagnostics() and the debug console log.
    const events = [];
    function note(type, detail) {
        events.push(Object.assign({ at: new Date().toISOString().slice(11, 23), type }, detail));
        if (events.length > 200) events.splice(0, events.length - 200);
        if (settings.debug) console.log(`[TwitchAdBlockHQ] ${type}`, detail ? JSON.stringify(detail) : '');
    }

    // 'hold' pauses the player: a starving player would lower its automatic quality and stop requesting playlists.
    let hold = null;
    function onStatus(status) {
        const previous = lastStatus;
        lastStatus = status;
        renderBanner(status);
        if (!previous || previous.mode !== status.mode || previous.source !== status.source) {
            note('status', { mode: status.mode, quality: status.quality, source: status.source, sourceQuality: status.sourceQuality });
        }
        if (status.adActive) {
            armPlaybackRecovery();
        }
        if (status.adActive && status.mode === 'hold') {
            // Keep naming the quality being watched, not the one automatic quality steps down to while starved.
            showWaitOverlay('hold', waitOverlay.reason === 'hold' && waitOverlay.detail ? waitOverlay.detail : status.quality);
        } else if (waitOverlay.reason === 'hold') {
            showWaitOverlay('resuming', 'The ad is over');
        }
        if (status.mode === 'hold') {
            if (!hold) {
                const video = findVideo();
                // At stream start the player hasn't played anything yet; it should start once the ad is handled.
                const current = { wasPlaying: !!video && !video.paused, startup: !video || video.readyState < 2, quality: readQuality(findMediaPlayer()), paused: false, timer: null };
                hold = current;
                if (current.wasPlaying && settings.pauseDuringHold) {
                    current.timer = setTimeout(() => {
                        const player = findMediaPlayer();
                        if (hold === current && player && typeof player.pause === 'function') {
                            note('pausing the player until the ad is over', { quality: current.quality });
                            current.paused = true;
                            player.pause();
                        }
                    }, effectiveTuning().holdPauseDelayMs);
                }
            }
        } else if (hold) {
            const ended = hold;
            clearTimeout(ended.timer);
            hold = null;
            const video = findVideo();
            if (ended.wasPlaying && !ended.paused && video && video.paused && !recovery.viewerPaused && reloadPlayer('the player stopped while waiting for the ad', false)) {
                // A player that ran dry and stopped itself tends to stay stuck (OFFLINE screen) or stop again after
                // play(): reloading it on the same, now ad-free session is the quickest way back.
                recovery.reloads++;
                recovery.lastReloadAt = Date.now();
                recovery.lastProgressAt = Date.now();
                restoreQuality(ended.quality);
            } else if (ended.wasPlaying || ended.startup) {
                note('resuming playback', { quality: ended.quality });
                resumePlayer();
                if (ended.paused) {
                    // The player restarts its pipeline: leave it alone apart from a late play() and the quality.
                    restoreQuality(ended.quality);
                    watchResume();
                } else {
                    scheduleStallCheck();
                }
            }
        } else if ((status.resumedAfterGap || status.changedRendition) && previous) {
            scheduleStallCheck();
        }
    }

    function resumePlayer() {
        const player = findMediaPlayer();
        if (player && typeof player.play === 'function') {
            player.play();
        } else {
            const video = findVideo();
            if (video) video.play().catch(() => {});
        }
    }

    function readQuality(player) {
        try {
            const quality = player && typeof player.getQuality === 'function' ? player.getQuality() : null;
            const auto = player && typeof player.isAutoQualityMode === 'function' ? player.isAutoQualityMode() : true;
            return quality && quality.name ? { name: quality.name, auto } : null;
        } catch (err) {
            return null;
        }
    }

    // Restarting the player can bring it back on automatic quality; put back a quality the viewer picked. Only once the
    // player is playing again: changing quality while it is still starting up leaves it stuck buffering.
    function restoreQuality(saved) {
        if (!saved || saved.auto) return;
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            try {
                const player = findMediaPlayer();
                const video = findVideo();
                const playing = player && typeof player.getState === 'function' ? player.getState() === 'Playing' : !!video && !video.paused && video.readyState >= 3;
                if (!playing || !video || video.currentTime < 1) {
                    if (attempts >= 60) clearInterval(timer);
                    return;
                }
                const qualities = typeof player.getQualities === 'function' ? player.getQualities() || [] : [];
                const match = qualities.find((quality) => quality.name === saved.name);
                if (match) {
                    const current = readQuality(player);
                    if (!current || current.auto || current.name !== saved.name) {
                        player.setQuality(match);
                        note('restored quality', { quality: saved.name, was: current && current.name });
                    }
                    clearInterval(timer);
                }
            } catch (err) {
                note('could not restore quality', { error: String(err) });
                clearInterval(timer);
            }
            if (attempts >= 40) clearInterval(timer);
        }, 500);
    }

    function watchResume() {
        setTimeout(() => {
            const video = findVideo();
            if (video && video.paused) {
                note('player still paused after the ad; starting it again');
                resumePlayer();
            }
        }, 8000);
    }

    // Cheap lookup of the stream's <video>, safe to call every second (unlike findMediaPlayer).
    function findVideo() {
        const videos = [...document.querySelectorAll('.video-player video'), ...document.getElementsByTagName('video')];
        return videos.find((video) => !isAdVideo(video) && video.dataset.twitchAdblockHq !== 'ad') || null;
    }

    // Twitch also plays ads outside the stream: separate <video> ads beside the player and in chat, served from the
    // Amazon ad CDN, plus stream display ads. The stream itself always plays from a MediaSource blob: URL, so the
    // host check can't match it.
    function isAdVideo(video) {
        const src = video.currentSrc || video.getAttribute('src') || '';
        if (!src || src.startsWith('blob:')) return false;
        try {
            return /(^|\.)media-amazon\.com$/.test(new URL(src, root.location.href).hostname);
        } catch (err) {
            return false;
        }
    }

    function hideDisplayAds() {
        if (!settings.hideDisplayAds) return;
        for (const video of document.getElementsByTagName('video')) {
            const marked = video.dataset.twitchAdblockHq === 'ad';
            if (isAdVideo(video)) {
                const src = video.currentSrc || video.getAttribute('src');
                if (!marked || video.dataset.twitchAdblockHqSrc !== src) {
                    if (!marked) video.dataset.twitchAdblockHqMuted = String(video.muted);
                    video.dataset.twitchAdblockHq = 'ad';
                    video.dataset.twitchAdblockHqSrc = src;
                    video.dataset.twitchAdblockHqPauses = '0';
                    note('hiding a separate video ad', { host: new URL(src, root.location.href).hostname, inPlayer: !!video.closest('.video-player') });
                }
                // Re-applied every time: re-renders can drop the style, and a hidden video would still play audio.
                video.style.setProperty('display', 'none', 'important');
                video.muted = true;
                // Pause a few times at most, so a player that keeps restarting the ad isn't fought forever.
                const pauses = Number(video.dataset.twitchAdblockHqPauses) || 0;
                if (!video.paused && pauses < 3) {
                    video.dataset.twitchAdblockHqPauses = String(pauses + 1);
                    video.pause();
                }
            } else if (marked) {
                // Twitch reuses <video> elements: restore one that now plays something else.
                video.style.removeProperty('display');
                video.muted = video.dataset.twitchAdblockHqMuted === 'true';
                for (const key of ['twitchAdblockHq', 'twitchAdblockHqMuted', 'twitchAdblockHqSrc', 'twitchAdblockHqPauses']) delete video.dataset[key];
                note('restored a reused video element');
            }
        }
        for (const element of document.querySelectorAll('[data-test-selector="sda-wrapper"]')) {
            element.style.setProperty('display', 'none', 'important');
        }
    }

    function startDisplayAdGuard() {
        for (const type of ['loadstart', 'play']) {
            document.addEventListener(type, (event) => {
                if (event.target instanceof HTMLVideoElement) hideDisplayAds();
            }, true);
        }
        setInterval(hideDisplayAds, 1000);
    }

    // Per-second playback samples of the stream's video element, for diagnostics.
    const samples = [];
    function startPlaybackSampler() {
        let previous = null;
        setInterval(() => {
            const video = findVideo();
            if (!video) return;
            const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
            const current = { time: video.currentTime, frames: quality ? quality.totalVideoFrames : 0, dropped: quality ? quality.droppedVideoFrames : 0, at: performance.now() };
            if (previous) {
                const seconds = (current.at - previous.at) / 1000 || 1;
                samples.push({
                    at: new Date().toISOString().slice(11, 19),
                    fps: Math.round((current.frames - previous.frames - (current.dropped - previous.dropped)) / seconds),
                    dropped: current.dropped - previous.dropped,
                    rate: Math.round(((current.time - previous.time) / seconds) * 100) / 100,
                    height: video.videoHeight,
                    paused: video.paused,
                });
                if (samples.length > 120) samples.shift();
            }
            previous = current;
        }, 1000);
    }

    function renderBanner(status) {
        const player = document.querySelector('.video-player');
        let banner = document.querySelector('.twitch-adblock-hq-banner');
        const visible = settings.showBanner && status && status.adActive && !!player && !waitOverlay.visible;
        if (!visible) {
            if (banner) banner.style.display = 'none';
            return;
        }
        if (!banner || banner.parentElement !== player) {
            if (banner) banner.remove();
            banner = document.createElement('div');
            banner.className = 'twitch-adblock-hq-banner';
            Object.assign(banner.style, {
                position: 'absolute', top: '0', left: '0', zIndex: '10', padding: '4px 8px', margin: '8px',
                borderRadius: '4px', background: 'rgba(0, 0, 0, 0.75)', color: '#fff', font: '12px/1.4 sans-serif', pointerEvents: 'none',
            });
            player.appendChild(banner);
        }
        let text;
        if (status.mode === 'backup') {
            text = `Ad blocked · ${status.quality}`;
        } else if (status.mode === 'lowres') {
            text = `Ad blocked · ${status.sourceQuality} until ${status.quality} is ad-free`;
        } else if (status.mode === 'hold') {
            text = `Ad blocked · waiting for an ad-free ${status.quality} stream`;
        } else {
            text = 'Ad blocked';
        }
        banner.textContent = text;
        banner.style.display = 'block';
    }

    // Covers the player while it waits for an ad-free stream or is being restarted, so Twitch's OFFLINE screen or a
    // frozen picture doesn't look like a crash. Only shown once the picture has actually stopped; clicks go through.
    const waitOverlay = { reason: null, detail: '', since: 0, element: null, timer: null, video: null, lastTime: -1, lastProgressAt: 0, visible: false };
    function showWaitOverlay(reason, detail) {
        if (waitOverlay.reason !== reason) waitOverlay.since = Date.now();
        waitOverlay.reason = reason;
        waitOverlay.detail = detail || '';
        if (!waitOverlay.timer) {
            waitOverlay.lastProgressAt = Date.now();
            waitOverlay.timer = setInterval(updateWaitOverlay, 500);
        }
        updateWaitOverlay();
    }

    function hideWaitOverlay() {
        clearInterval(waitOverlay.timer);
        Object.assign(waitOverlay, { reason: null, timer: null, video: null, lastTime: -1 });
        setWaitOverlayVisible(false);
    }

    function updateWaitOverlay() {
        const now = Date.now();
        const video = findVideo();
        // A new video element (after a reload) starts from its own time: only count progress on the same element.
        if (video && video === waitOverlay.video && !video.paused && video.readyState >= 3 && video.currentTime !== waitOverlay.lastTime) {
            waitOverlay.lastProgressAt = now;
        }
        waitOverlay.video = video;
        waitOverlay.lastTime = video ? video.currentTime : -1;
        const stopped = (!!video && video.paused) || now - waitOverlay.lastProgressAt >= 1000;
        if (waitOverlay.reason === 'resuming' && ((!stopped && now - waitOverlay.since >= 1000) || now - waitOverlay.since > 45000)) {
            hideWaitOverlay();
            return;
        }
        if (!settings.showBanner || !stopped || recovery.viewerPaused) {
            setWaitOverlayVisible(false);
            return;
        }
        const seconds = Math.floor((now - waitOverlay.since) / 1000);
        const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (waitOverlay.reason === 'hold') {
            setWaitOverlayVisible(true, 'Ad break blocked', `Waiting for an ad-free ${[waitOverlay.detail, 'stream'].filter(Boolean).join(' ')} · ${elapsed}`);
        } else {
            setWaitOverlayVisible(true, 'Resuming the stream…', waitOverlay.detail);
        }
    }

    function setWaitOverlayVisible(visible, title, detail) {
        const player = document.querySelector('.video-player');
        let element = waitOverlay.element;
        if (!visible || !player) {
            if (element) element.style.display = 'none';
            if (waitOverlay.visible) {
                waitOverlay.visible = false;
                renderBanner(lastStatus);
            }
            return;
        }
        if (!element || element.parentElement !== player) {
            if (element) element.remove();
            element = document.createElement('div');
            element.className = 'twitch-adblock-hq-overlay';
            Object.assign(element.style, {
                position: 'absolute', inset: '0', zIndex: '1000', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(14, 14, 16, 0.92)', color: '#efeff1', font: '14px/1.4 sans-serif', textAlign: 'center', pointerEvents: 'none',
            });
            const spinner = document.createElement('div');
            Object.assign(spinner.style, {
                width: '36px', height: '36px', margin: '0 auto 14px', borderRadius: '50%', boxSizing: 'border-box',
                border: '4px solid rgba(255, 255, 255, 0.2)', borderTopColor: '#a970ff',
            });
            if (typeof spinner.animate === 'function') {
                spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
            }
            const heading = document.createElement('div');
            heading.className = 'twitch-adblock-hq-overlay-title';
            Object.assign(heading.style, { fontSize: '18px', fontWeight: '600' });
            const text = document.createElement('div');
            text.className = 'twitch-adblock-hq-overlay-detail';
            Object.assign(text.style, { marginTop: '4px', opacity: '0.75' });
            const box = document.createElement('div');
            box.append(spinner, heading, text);
            element.appendChild(box);
            player.appendChild(element);
            waitOverlay.element = element;
        }
        element.querySelector('.twitch-adblock-hq-overlay-title').textContent = title;
        element.querySelector('.twitch-adblock-hq-overlay-detail').textContent = detail || '';
        element.style.display = 'flex';
        if (!waitOverlay.visible) {
            waitOverlay.visible = true;
            renderBanner(lastStatus);
        }
    }

    // After an ad without a pause, the player can get stuck: skipped time leaves a hole in its buffer, and a quality change
    // can leave the picture frozen while audio keeps playing. Watch playback for a while and fix these gently.
    let stallWatchTimer = null;
    function scheduleStallCheck() {
        clearInterval(stallWatchTimer);
        const startedAt = Date.now();
        let lastTime = -1;
        let lastFrames = -1;
        let stuckSince = 0;
        let frozenSince = 0;
        let fixes = 0;
        stallWatchTimer = setInterval(() => {
            const video = findVideo();
            if (!video || Date.now() - startedAt > 30000) {
                clearInterval(stallWatchTimer);
                return;
            }
            const time = video.currentTime;
            if (video.readyState < 3) {
                for (let i = 0; i < video.buffered.length; i++) {
                    const start = video.buffered.start(i);
                    if (start > time && start - time < 60) {
                        note('skipping buffer gap left by the ad', { seconds: Math.round((start - time) * 10) / 10 });
                        video.currentTime = start + 0.05;
                        return;
                    }
                }
            }
            const stuck = time === lastTime && video.paused && Date.now() - startedAt < 8000;
            stuckSince = stuck ? stuckSince || Date.now() : 0;
            // Browsers stop decoding video in hidden tabs, so frame counts are only meaningful while visible.
            const frames = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality().totalVideoFrames : -1;
            const frozen = !video.paused && document.visibilityState === 'visible' && time !== lastTime && frames > 0 && frames === lastFrames;
            frozenSince = frozen ? frozenSince || Date.now() : 0;
            lastTime = time;
            lastFrames = frames;
            if (fixes >= 3) return;
            if (stuckSince && Date.now() - stuckSince > 3000) {
                fixes++;
                stuckSince = 0;
                note('player paused after the ad; starting it again');
                resumePlayer();
            } else if (frozenSince && Date.now() - frozenSince > 3000) {
                fixes++;
                frozenSince = 0;
                note('picture frozen while audio plays; resynchronising video', { attempt: fixes });
                if (fixes === 1) {
                    // Seeking in place makes the browser flush and resynchronise the video with the audio.
                    video.currentTime = video.currentTime;
                } else {
                    const player = findMediaPlayer();
                    if (player && typeof player.pause === 'function' && typeof player.play === 'function') {
                        player.pause();
                        player.play();
                    }
                }
            }
        }, 500);
    }

    // Twitch's React components for the stream: the media player, and the component that loads the player's source
    // (used to reload it). Twitch can have several players (e.g. a preview), so prefer the one whose video is largest.
    let cachedComponents = null;
    let cachedComponentsAt = 0;
    function findMediaPlayer() {
        return findPlayerComponents().player;
    }

    function findPlayerComponents() {
        if (cachedComponents && Date.now() - cachedComponentsAt < 2000) return cachedComponents;
        const rootNode = document.querySelector('#root');
        if (!rootNode) return { player: null, loader: null };
        const containerKey = Object.keys(rootNode).find((key) => key.startsWith('__reactContainer'));
        let fiber = containerKey ? rootNode[containerKey] : rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current;
        const stack = fiber ? [fiber] : [];
        const candidates = [];
        let loader = null;
        let visited = 0;
        while (stack.length && visited++ < 50000) {
            fiber = stack.pop();
            const node = fiber.stateNode;
            if (node && node.setPlayerActive && node.props && node.props.mediaPlayerInstance) {
                const instance = node.props.mediaPlayerInstance;
                const player = instance.playerInstance || instance;
                if (!candidates.includes(player)) candidates.push(player);
            }
            if (!loader && node && typeof node.setSrc === 'function' && node.setInitialPlaybackSettings) {
                loader = node;
            }
            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
        }
        const area = (player) => {
            try {
                const video = typeof player.getHTMLVideoElement === 'function' ? player.getHTMLVideoElement() : null;
                return video && video.isConnected ? video.clientWidth * video.clientHeight : 0;
            } catch (err) {
                return 0;
            }
        };
        candidates.sort((a, b) => area(b) - area(a));
        cachedComponents = { player: candidates[0] || null, loader };
        cachedComponentsAt = Date.now();
        return cachedComponents;
    }

    // Reloads the player the way Twitch does when switching streams: a fresh player without any leftover errors.
    // Without newSession it keeps the current playback session, so no new preroll is requested.
    function reloadPlayer(reason, newSession) {
        const { player, loader } = findPlayerComponents();
        if (!loader) {
            note('could not find the player to reload', { reason });
            return false;
        }
        note('reloading the player', { reason, newSession: !!newSession });
        showWaitOverlay('resuming', 'Restarting the player');
        cachedComponents = null;
        loader.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: !!newSession });
        if (player && typeof player.play === 'function') player.play();
        return true;
    }

    // After an ad, Twitch's player can stop for good: paused behind its OFFLINE screen while the stream is live, where
    // play() no longer helps. While ads are being handled (and for a while after), watch for playback that should be
    // running but isn't: start the player again, then reload it. Pauses by the viewer are left alone.
    const recovery = { armedUntil: 0, timer: null, lastTime: -1, lastProgressAt: 0, lastInputAt: 0, viewerPaused: false, plays: 0, reloads: 0, lastReloadAt: 0 };
    function startPlaybackRecovery() {
        const markInput = () => { recovery.lastInputAt = Date.now(); };
        document.addEventListener('pointerdown', markInput, true);
        document.addEventListener('keydown', markInput, true);
        document.addEventListener('pause', (event) => {
            if (event.target instanceof HTMLVideoElement && Date.now() - recovery.lastInputAt < 1500) recovery.viewerPaused = true;
        }, true);
        document.addEventListener('play', (event) => {
            if (event.target instanceof HTMLVideoElement) recovery.viewerPaused = false;
        }, true);
    }

    function armPlaybackRecovery() {
        const now = Date.now();
        if (recovery.armedUntil < now) {
            recovery.plays = 0;
            recovery.reloads = 0;
            recovery.lastProgressAt = now;
        }
        recovery.armedUntil = now + 10 * 60000;
        if (!recovery.timer) recovery.timer = setInterval(checkPlaybackRecovery, 1000);
    }

    function checkPlaybackRecovery() {
        const now = Date.now();
        if (now > recovery.armedUntil) {
            clearInterval(recovery.timer);
            recovery.timer = null;
            return;
        }
        const video = findVideo();
        if (!video) return;
        const advancing = !video.paused && video.currentTime !== recovery.lastTime;
        recovery.lastTime = video.currentTime;
        const waitingOnPurpose = lastStatus && lastStatus.mode === 'hold';
        if (advancing || waitingOnPurpose || recovery.viewerPaused || document.visibilityState !== 'visible') {
            if (advancing) {
                recovery.plays = 0;
                if (now - recovery.lastReloadAt > 60000) recovery.reloads = 0;
            }
            recovery.lastProgressAt = now;
            return;
        }
        const stuckFor = now - recovery.lastProgressAt;
        if ((stuckFor >= 4000 && recovery.plays === 0) || (stuckFor >= 8000 && recovery.plays === 1)) {
            recovery.plays++;
            note('playback stopped; starting the player again', { stuckSeconds: Math.round(stuckFor / 1000) });
            showWaitOverlay('resuming', waitOverlay.reason === 'resuming' ? waitOverlay.detail : '');
            for (let i = 0; i < video.buffered.length; i++) {
                const start = video.buffered.start(i);
                if (start > video.currentTime && start - video.currentTime < 60) {
                    video.currentTime = start + 0.05;
                    break;
                }
            }
            resumePlayer();
        } else if (stuckFor >= 12000 && recovery.reloads < 3 && now - recovery.lastReloadAt > 20000) {
            recovery.reloads++;
            recovery.lastReloadAt = now;
            recovery.plays = 0;
            recovery.lastProgressAt = now;
            // First keep the session; if that didn't help (e.g. the session expired), start a new one.
            reloadPlayer(`playback stopped for ${Math.round(stuckFor / 1000)}s`, recovery.reloads > 1);
        }
    }

    function diagnostics() {
        const player = findMediaPlayer();
        let own = findVideo();
        try {
            own = (player && typeof player.getHTMLVideoElement === 'function' && player.getHTMLVideoElement()) || own;
        } catch (err) {
            // keep the DOM lookup
        }
        const videos = [...document.getElementsByTagName('video')].map((video) => {
            const src = video.currentSrc || video.getAttribute('src') || '';
            const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : {};
            let host = src;
            try {
                host = src.startsWith('blob:') ? 'blob' : src ? new URL(src, root.location.href).hostname : '';
            } catch (err) {
                // keep the raw value
            }
            return {
                stream: video === own,
                src: host,
                display: getComputedStyle(video).display,
                size: `${video.clientWidth}x${video.clientHeight}`,
                decoded: `${video.videoWidth}x${video.videoHeight}`,
                paused: video.paused,
                muted: video.muted,
                readyState: video.readyState,
                time: Math.round(video.currentTime * 10) / 10,
                frames: quality.totalVideoFrames,
                dropped: quality.droppedVideoFrames,
                hiddenAsAd: video.dataset.twitchAdblockHq === 'ad',
            };
        });
        let playerState = null;
        try {
            playerState = player ? { state: typeof player.getState === 'function' ? player.getState() : null, quality: readQuality(player) } : null;
        } catch (err) {
            playerState = { error: String(err) };
        }
        const playerElement = document.querySelector('.video-player');
        const report = {
            version: VERSION,
            browser: navigator.userAgent,
            settings,
            status: lastStatus,
            player: playerState,
            offlineShown: !!playerElement && playerElement.innerText.includes('OFFLINE'),
            overlay: waitOverlay.reason ? { reason: waitOverlay.reason, visible: waitOverlay.visible, seconds: Math.round((Date.now() - waitOverlay.since) / 1000) } : null,
            recovery: { armed: recovery.armedUntil > Date.now(), viewerPaused: recovery.viewerPaused, reloads: recovery.reloads, reloadable: !!findPlayerComponents().loader },
            videos,
            playbackLastMinute: samples.slice(-60).map((s) => `${s.at} ${s.fps}fps dropped:${s.dropped} speed:${s.rate} ${s.height}p${s.paused ? ' paused' : ''}`),
            events: events.slice(-60),
        };
        console.log(`[TwitchAdBlockHQ] diagnostics\n${JSON.stringify(report, null, 1)}`);
        return report;
    }

    function exposeApi() {
        root.twitchAdBlockHQ = Object.freeze({
            version: VERSION,
            getSettings: () => Object.assign({}, settings),
            setSettings(partial) {
                settings = sanitizeSettings(Object.assign({}, settings, partial));
                saveSettings();
                broadcast({ type: 'settings', value: settings });
                return Object.assign({}, settings);
            },
            resetSettings() {
                settings = Object.assign({}, DEFAULT_SETTINGS);
                saveSettings();
                broadcast({ type: 'settings', value: settings });
                return Object.assign({}, settings);
            },
            status: () => lastStatus,
            // Snapshot of playback, video elements and recent actions, for bug reports.
            diagnostics,
            // Pretend the player's session shows an ad. includeBackups also pretends full quality backups do.
            simulateAd(seconds = 60, includeBackups = false) {
                broadcast({ type: 'simulate-ad', seconds, includeBackups });
            },
        });
    }

    hookFetch();
    hookWorker();
    startDisplayAdGuard();
    startPlaybackSampler();
    startPlaybackRecovery();
    exposeApi();
    console.log(`[TwitchAdBlockHQ] v${VERSION} active (fallback: ${settings.fallbackMode})`);
    if (settings.debug) console.log('[TwitchAdBlockHQ] settings', JSON.stringify(settings));
})(typeof window !== 'undefined' ? window : globalThis);
