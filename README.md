# Twitch AdBlock HQ

A userscript that blocks Twitch ads **without dropping the stream to low quality**.

Existing script-based blockers (e.g. [TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) `vaft` /
`video-swap-new`) replace the ad with a backup stream that is usually 360p, and often keep showing it for a while after
the ad has ended. This script only ever plays the quality you selected, and never reloads the player.

## Install

**Userscript (recommended).** Install a userscript manager ([Violentmonkey](https://violentmonkey.github.io/),
[Tampermonkey](https://www.tampermonkey.net/)), then open
[`twitch-adblock-hq.user.js`](https://github.com/Nello1717/TwitchAdBlock/raw/main/twitch-adblock-hq.user.js).
On Chromium browsers with Manifest V3 userscript managers, enable *Allow user scripts* for the extension in
`chrome://extensions`.

**uBlock Origin.**
1. In the uBlock Origin dashboard, enable *I am an advanced user* and click the cog.
2. Set `userResourcesLocation` to
   `https://raw.githubusercontent.com/Nello1717/TwitchAdBlock/main/twitch-adblock-hq-ublock-origin.js`.
3. Add the filter `twitch.tv##+js(twitch-videoad)` under *My filters*.
4. Restart the browser.

uBlock Origin keeps its downloaded copy of the script until the address changes; restarting or "Update now" doesn't
refresh it. To get a new version, add or change a version suffix at the end of the address, e.g. `...ublock-origin.js?v=1.1.2`,
and click *Apply changes*.

Don't combine it with other Twitch-specific ad blockers.

**Stay up to date.** Every script update is published as a [release](https://github.com/Nello1717/TwitchAdBlock/releases).
To be notified, click *Watch* > *Custom* > *Releases* on this repository. Userscript managers update on their own;
uBlock Origin users can copy the address pinned in each release's notes into `userResourcesLocation`.

## Why other scripts end up in low quality

These observations come from live twitch.tv playlists (September 2026):

- Twitch stitches ads into the HLS media playlist of each playback session (access token). Full-quality player
  types (`site`, `embed`, `popout`, `frontpage`, …) get ads. The preview player types that stay ad-free (`autoplay`,
  `picture-by-picture`) only offer **360p and 160p**. Falling back to them is where the quality drop comes from.
- Ads are decided **per session**. When your session shows an ad, another fresh full-quality session is often
  ad-free. If it has its own preroll, that preroll ends after ~15–30 seconds just by polling its playlist.
- Every session carries the **same live segments**: identical sequence numbers, timestamps and segment durations.
  A session that started with an ad numbers its segments from 0, but `#EXT-X-TWITCH-LIVE-SEQUENCE` always holds the
  channel-wide number of its first live segment.
- After an ad, the `stitched-ad` marker stays in the playlist for ~30 seconds even though live video is already
  back. Scripts that look for that marker keep showing the low-quality backup during that time.
- Some ad breaks only *announce* the ad: the playlist carries ad markers while every segment stays live. Scripts that
  judge sessions by marker strings (e.g. `vaft` in the actively maintained
  [ryanbr fork](https://github.com/ryanbr/TwitchAdSolutions), whose changelog reports this as the common case) treat
  every full-quality backup as ad-laden and fall back to 360p. This script judges the segments themselves. It keeps
  playing your session at full quality and leaves the markers out of the playlist the player receives.
- Swapping whole playlists between sessions makes the sequence numbers jump (e.g. from 0 to 16913). This is a likely
  cause of the freezes, repeated segments and player reloads those scripts are known for.

## How it works

1. The script hooks the Twitch player's Web Worker and sees every playlist the player loads.
2. Without ads, playlists pass through untouched.
3. When your session shows an ad, the script opens backup sessions in parallel (`site`, `popout`, `mobile_web`, `embed` by default).
   It uses the one that is ad-free **at exactly your rendition**: same resolution, frame rate, codec and bitrate. A
   backup with its own preroll is kept alive until that preroll finishes, then used for the rest of the ad break.
4. Live segments from your session and the backups are merged into **one continuous playlist**, aligned by the
   channel-wide sequence number. The player never sees an ad segment, a sequence jump or a duplicate segment. It keeps
   playing, so there is no reload, no black screen and no quality ramp-up.
5. When your session is ad-free again, playback switches back seamlessly.
6. If no ad-free stream at your quality exists yet (e.g. every session is in the same midroll), the `fallbackMode`
   setting decides what happens:
   - `hold` (default): never lower the quality. The player waits behind a notice while the script keeps checking.
     As soon as your session or a backup is ad-free at your quality, playback continues at the live edge.
   - `lowres`: show the best lower-quality ad-free stream (usually 360p). Switch back to your quality the moment
     any session offers it ad-free.

Tested live against twitch.tv. With a real preroll on the player's session, the stream started on time and played the
whole ad break at full quality from a backup session. It then switched back to the player's session without a stall.
The automated tests cover the playlist handling with a model of Twitch's behaviour.

## Ads outside the stream

Since mid-2026 Twitch also plays ads that never pass through the stream: separate `<video>` ads beside the player
and in chat (served from the Amazon ad CDN), and stream display ads. With `hideDisplayAds` (on by default), these are
hidden, muted and paused. The stream itself always plays from a `blob:` URL, so it can't be mistaken for one of them.
Ads rendered inside cross-origin iframes can't be reached from a userscript.

## Settings

Settings are stored in `localStorage` and changed from the browser console on twitch.tv:

```js
twitchAdBlockHQ.setSettings({ fallbackMode: 'lowres' })
twitchAdBlockHQ.getSettings()
twitchAdBlockHQ.resetSettings()
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `fallbackMode` | `'hold'` | `'hold'` never lowers quality. `'lowres'` temporarily shows a lower-quality ad-free stream. |
| `minFallbackHeight` | `0` | `lowres` only: never show a fallback below this height (e.g. `480`). |
| `pauseDuringHold` | `false` | `hold` only: pause the player while waiting instead of showing a loading spinner. Can leave the video stuttering after the ad (seen in Opera GX), so it's off by default. |
| `resumeAtLiveEdge` | `true` | `hold` only: after waiting more than a few seconds, continue at the live edge. `false` continues where playback stopped when that part is still available (up to ~30 s), adding delay. |
| `backupPlayerTypes` | `['site', 'popout', 'mobile_web', 'embed']` | Player types used for full-quality backup sessions (`'type'` or `'type/platform'`). All are opened in parallel; the order only breaks ties. |
| `fallbackPlayerTypes` | `['autoplay/android']` | Player types used for the `lowres` fallback. |
| `forcePlayerType` | `'popout'` | Player type requested for your own session instead of `site` (`null` = unchanged). |
| `hideDisplayAds` | `true` | Hide, mute and pause separate video ads and stream display ads (see above). |
| `showBanner` | `true` | Show a small notice on the player while an ad is blocked. |
| `debug` | `false` | Log decisions to the console (page and worker), including client-side ad requests. |
| `tuning` | `{}` | Advanced: override timing values from `TUNING` in the script, e.g. `{ sessionWaitMs: 2000 }`. Unknown keys and invalid numbers are ignored. |

Changes apply immediately, except `debug`, which needs a page reload to log client-side ad requests.

## Limitations

- During ads, the script can only play a quality that some Twitch session delivers ad-free. It checks several
  sessions at once. If none qualifies, `hold` waits and `lowres` shows lower quality; it never shows the ad.
- While `hold` waits, Twitch's automatic quality selection may step down; it recovers after the ad. Choosing a
  fixed quality in the player avoids this.
- A player type that keeps failing (Twitch sometimes answers token requests for `embed` with a GQL "server error")
  is retried with increasing delays, up to once a minute. Backup sessions are kept for 30 seconds after an ad in case
  ad markers come back.
- Behaviour in background tabs has not been tested as thoroughly as in visible tabs.
- 1440p and 4K renditions require being logged in (Twitch restricts them for anonymous viewers). Backup sessions
  reuse your login, so they get the same renditions as your player.
- The mobile site (`m.twitch.tv`) and VODs are not handled.
- Twitch changes its site regularly. If something breaks, enable `debug` and check the console for
  `[TwitchAdBlockHQ]` messages.

## Troubleshooting

- **Is it running?** The console should show `[TwitchAdBlockHQ] v1.1.2 active`. With `debug: true` it also logs
  `worker hooks installed` when a stream loads.
- **Try the ad path without waiting for an ad:** `twitchAdBlockHQ.simulateAd(30)` pretends your session shows a
  30-second ad. `twitchAdBlockHQ.simulateAd(30, true)` pretends full-quality backups do too, which exercises
  `hold` / `lowres`.
- `twitchAdBlockHQ.status()` returns the latest state (mode, quality, backup in use).
- **Playback problems:** run `twitchAdBlockHQ.diagnostics()` while it happens. It prints the player state, every
  video element (frames, dropped frames, buffer), the playback rate of the last minute and the script's recent actions.

## Development

```bash
npm test        # unit and integration tests (Node 20+), and checks the uBlock Origin file is up to date
npm run build   # regenerate twitch-adblock-hq-ublock-origin.js from the userscript
```

- `twitch-adblock-hq.user.js` is the only source file. The playlist logic (`createPlaylistLib`) and worker logic
  (`workerMain`) are plain functions, injected into the player's worker and loaded by the tests.
- `tests/fake-twitch.js` models Twitch's per-session ads, session-relative numbering and live sequence tags. The
  integration tests check that every playlist the player receives is ad-free and continuous: no reused sequence
  numbers, no repeated or skipped content.
- Pushing a change to either script on `main` runs the tests and publishes a release
  ([release workflow](.github/workflows/release.yml)). Releases are named after `@version`, so bump it together with
  `VERSION` in the script; a change without a bump is still released (e.g. `v1.1.2-r7`) but userscript managers won't
  offer it. Preview the release notes with `node tools/release-info.js`.

## Credits

The Web Worker injection technique and the React player lookup are adapted from
[TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT License,
Copyright (c) 2020-present TwitchAdSolutions Contributors). Field findings from the
[ryanbr fork](https://github.com/ryanbr/TwitchAdSolutions) informed the separate video ad guard, the extra ad signals
(SCTE-35 cues, `twitch-stitched-*` classes, ad segment URLs), the iframe filter and the backup retry behaviour.

## License

[MIT](LICENSE)
