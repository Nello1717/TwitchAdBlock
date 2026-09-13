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

Don't combine it with other Twitch-specific ad blockers.

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
- Swapping whole playlists between sessions makes the sequence numbers jump (e.g. from 0 to 16913). This is a likely
  cause of the freezes, repeated segments and player reloads those scripts are known for.

## How it works

1. The script hooks the Twitch player's Web Worker and sees every playlist the player loads.
2. Without ads, playlists pass through untouched.
3. When your session shows an ad, the script opens backup sessions in parallel (`embed`, `site`, `popout` by default).
   It uses the one that is ad-free **at exactly your rendition**: same resolution, frame rate, codec and bitrate. A
   backup with its own preroll is kept alive until that preroll finishes, then used for the rest of the ad break.
4. Live segments from your session and the backups are merged into **one continuous playlist**, aligned by the
   channel-wide sequence number. The player never sees an ad segment, a sequence jump or a duplicate segment. It keeps
   playing, so there is no reload, no black screen and no quality ramp-up.
5. When your session is ad-free again, playback switches back seamlessly.
6. If no ad-free stream at your quality exists yet (e.g. every session is in the same midroll), the `fallbackMode`
   setting decides what happens:
   - `hold` (default): never lower the quality. The player pauses behind a notice, and the script keeps checking
     in the background. As soon as your session or a backup is ad-free at your quality, playback continues at the
     live edge. Pausing, rather than letting the player starve, also stops Twitch's automatic quality selection
     from stepping down.
   - `lowres`: show the best lower-quality ad-free stream (usually 360p). Switch back to your quality the moment
     any session offers it ad-free.

Tested live against twitch.tv. With a real preroll on the player's session, the stream started on time and played the
whole ad break at full quality from a backup session. It then switched back to the player's session without a stall.
The automated tests cover the playlist handling with a model of Twitch's behaviour.

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
| `backupPlayerTypes` | `['embed', 'site', 'popout']` | Player types used for full-quality backup sessions (`'type'` or `'type/platform'`). |
| `fallbackPlayerTypes` | `['autoplay/android']` | Player types used for the `lowres` fallback. |
| `forcePlayerType` | `'popout'` | Player type requested for your own session instead of `site` (`null` = unchanged). |
| `showBanner` | `true` | Show a small notice on the player while an ad is blocked. |
| `debug` | `false` | Log decisions to the console (page and worker). |

Reload the page after changing `backupPlayerTypes`, `forcePlayerType` or `showBanner`.

## Limitations

- During ads, the script can only play a quality that some Twitch session delivers ad-free. It checks several
  sessions at once. If none qualifies, `hold` pauses and `lowres` shows lower quality; it never shows the ad.
- 1440p and 4K renditions require being logged in (Twitch restricts them for anonymous viewers). Backup sessions
  reuse your login, so they get the same renditions as your player.
- The mobile site (`m.twitch.tv`) and VODs are not handled.
- Twitch changes its site regularly. If something breaks, enable `debug` and check the console for
  `[TwitchAdBlockHQ]` messages.

## Troubleshooting

- **Is it running?** The console should show `[TwitchAdBlockHQ] v1.0.0 active`. With `debug: true` it also logs
  `worker hooks installed` when a stream loads.
- **Try the ad path without waiting for an ad:** `twitchAdBlockHQ.simulateAd(30)` pretends your session shows a
  30-second ad. `twitchAdBlockHQ.simulateAd(30, true)` pretends full-quality backups do too, which exercises
  `hold` / `lowres`.
- `twitchAdBlockHQ.status()` returns the latest state (mode, quality, backup in use).

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

## Credits

The Web Worker injection technique and the React player lookup are adapted from
[TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT License,
Copyright (c) 2020-present TwitchAdSolutions Contributors).

## License

[MIT](LICENSE)
