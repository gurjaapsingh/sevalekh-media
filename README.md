# 📦 SevaLekh media robot (backup)

Every morning (India time) this makes the day's **ਮੁੱਖਵਾਕ pictures and videos** — the same cards phones draw, with SevaLekh's approved vyakhya — and publishes them on **GitHub Pages**. The app can then hand people ready-made files instead of making videos on their phones.

It is **free**: GitHub Actions and GitHub Pages cost nothing for a public repository. Nothing here touches Firebase, so SevaLekh stays on the free Spark plan.

What it makes, for each language in `LANGS` (default `pa,en,pnb,hi` — ਪੰਜਾਬੀ, English, شاہمکھی, हिन्दी):

| | |
|---|---|
| Pictures 9:16 and 4:5 | `mukhwak/pa/story-01.jpg …`, `mukhwak/pa/post-01.jpg …` |
| Videos 9:16 | `video-reel.mp4` (90 s) — the start, at 1.5× (no 1-minute video: every platform takes 90 s); `video-full.mp4` (whole recording, normal speed); `video-fit.mp4` (whole, sped up just enough to last 2:59) — each under 44 MB |
| Videos 4:5 | the same, named `video-4x5-reel.mp4` … (Instagram / Facebook feed; switch in Admin) |
| Thumbnails | `thumb.jpg` 1280×720 (YouTube) and `preview.jpg` 1200×630 (link previews): ਮੁੱਖਵਾਕ · date, the opening Gurbani, granth.web.app |
| Index for the app | `mukhwak/latest.json` |
| A page for people | `index.html` |

## How it works

1. A headless browser opens `https://sevalekh.com/#/mukhwak` and asks the page for its cards (`window.sevalekhMukhwak`, in `src/mediaBot.ts`). So the robot needs no keys and no copy of SevaLekh's data — it sees what any visitor sees.
2. It downloads SGPC's recording directly (no browser, so SGPC's CORS block doesn't matter).
3. ffmpeg turns cards + audio into the videos. The cards follow the recitation: the first card stays over the opening (25 s at 1×), the verses in proportion, and the closing card over the repeat at the recording's end (about 14% of it, 12–90 s — the last verses and the opening sung again). The 90-second video keeps those timings and ends on a few seconds of the closing card. Videos are encoded three at a time with x264's `veryfast` preset (still pictures don't gain from slower presets), so a run of 24 videos (3 kinds × 2 sizes × 4 languages) takes a few minutes.
4. The workflow publishes the result on GitHub Pages, replacing yesterday's.

A quick check (`check.mjs`, a few seconds) runs every 15 minutes from 05:15 to 12:45 India time (17:45–01:15 the evening before in Edmonton). The slow build starts only once BaniDB has today's MukhWak, SGPC's audio is up, and today's isn't published yet — so early checks just wait instead of failing. GitHub often starts scheduled runs late or skips slots when it's busy; many cheap checks make the morning video dependable.

**Edited meanings:** the check also runs hourly for the rest of India's day. If meanings of today's MukhWak were edited or approved after the morning's run, it makes everything again (without posting to Telegram again). It notices changes by a fingerprint of the approved entries (`fingerprint.mjs`, Firestore's public API — no key).

**Visitors' copy (`snapshot.mjs`):** each build also writes `data/approved.json` and `data/definitions.json` — every approved meaning and Shabadkosh definition, without volunteers' account ids or edit history. SevaLekh's public view and public dictionary load these instead of reading each entry from the database, which keeps Firebase's free plan (50,000 reads a day) from running out. The Ang a visitor opens is still read live.

## Set up (about 10 minutes, once)

1. On GitHub, create a **new public repository**, e.g. `sevalekh-media`.
2. Copy **the contents of this `media-bot` folder** (including the hidden `.github` folder) into the repository's root, and push. In PowerShell from `D:\github_projects\sevalekh\media-bot`:
   ```
   git init
   git add -A
   git commit -m "SevaLekh media robot"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/sevalekh-media.git
   git push -u origin main
   ```
3. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Actions** tab → *Daily MukhWak media* → **Run workflow** (tick *force* the first time). It takes a few minutes.
5. Open `https://YOUR-NAME.github.io/sevalekh-media/` — today's pictures and videos should be there.
6. In SevaLekh: **Admin → 2 · MukhWak → 📦 Ready-made pictures & videos** — paste `https://YOUR-NAME.github.io/sevalekh-media`, **Save**, **Check**, and switch it on. Tick *Use only those* if phones should stop making videos themselves.

Optional (repository **Settings → Secrets and variables → Actions → Variables**):

- `LANGS` — e.g. `pa,en,pnb,hi` (any language the MukhWak page offers that day)
- `APP_URL` — if SevaLekh moves to its own domain
- `AUDIO_RELAY` — your Cloudflare audio relay address (same as in SevaLekh's Admin), used only if SGPC turns the robot away

## Posting to social media

- **Telegram channel — built in.** Add the secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` and every morning's run posts the video file (caption without the audio link) and the MukhWak text (with the audio link) to your channel.
- Facebook, Instagram, YouTube, WhatsApp, X, TikTok and others: step-by-step in **[SOCIAL-AUTOPOST.md](SOCIAL-AUTOPOST.md)**.

## Karaoke clips (`karaoke-video.mjs`)

A few lines of the paath as a 9:16 clip: the recording's audio, and the Gurbani over it with **each word turning gold as it is recited**. It reads the timing files SevaLekh's `tools/paath-align/align.py` writes (`public/paath/<reciter>/<ang>.json`, `[verseId, recording, lineStart, lineEnd, [wordStart…]]`, seconds into the recording) and cuts the audio with `ffmpeg -ss … -to …`, so the subtitles' `t = 0` is the start of the cut.

```
node karaoke-video.mjs --align ../sevalekh/public/paath/mehnga-singh --audio D:/paath --verses 18686-18690 --out out/clip.mp4
```

- `--align` an Ang's file or the reciter's folder (all Angs are searched; `--ang 1-3` narrows it). `--audio` the recording, or the folder holding `<recording>.mp3` — the name the timing file gives. `--verses 5-9` (or one verse id) all from one recording.
- **Text:** the timing files hold no Gurmukhi. It comes from `--text file.json` (`{"<verseId>": "…"}`), else the cached Ang pages in `--cache-dir` (default `.cache/ang`, the cache SevaLekh's tools fill — point it at `../sevalekh/.cache/ang` to reuse it), else BaniDB (then cached). A line whose words don't match its timings stops the run, naming the verse.
- Needs **ffmpeg with libass and libx264** and *Noto Sans Gurmukhi*, which it takes from this repo's `fonts/` (`--font` and `--fonts-dir` use another). `--bg solid|gradient`, `--bg-color`, `--bg-color2`, `--font-size`, `--pad-start/--pad-end` (seconds of recording kept either side), `--ass file` keeps the subtitles, `--accurate-seek` for VBR mp3s without a seek table.
- In ASS the *Primary* colour is what a sung word becomes and *Secondary* what it is until then, so the style is Primary = gold `&H0000D7FF&`, Secondary = white `&H00FFFFFF&`.

**Try it** (makes a stand-in recording with a beep at every word, then a clip of Ang 1's first six lines from the mock timings in `samples/karaoke/`; the demo lands in `out/karaoke-demo.mp4`):

```
node samples/karaoke/make-mock-audio.mjs samples/karaoke/alignment/1.json out/mock-audio
node karaoke-video.mjs --align samples/karaoke/alignment --audio out/mock-audio \
     --text samples/karaoke/text.json --verses 1-6 --out out/karaoke-demo.mp4
npm run test:karaoke      # the same, with checks on the MP4: audio against the source, colours, when each word lights
```

## Good to know

- **Speeds:** the 90-second video uses the Admin's chop speed (1.5× by default); `video-fit.mp4` picks its own speed (recording length ÷ 179 s). Any other speed can be made on a phone in the app (⏩ ×). Each run's log prints the settings it saw.

- **GitHub pauses scheduled workflows** in a repository with no activity for 60 days. If it stops, open Actions and re-enable it (or push any small change).
- **Limits:** GitHub Pages sites up to 1 GB, about 100 GB of downloads a month — far more than a day's files (roughly 60–80 MB for three languages).
- The **audio is SGPC's**. Sharing their recording is common, but if you also upload these videos to YouTube regularly, asking SGPC first is wise; YouTube may also flag the audio.
- To test locally: `npm install`, `npx playwright install chromium`, have `ffmpeg` installed, then `node make.mjs` (output in `site/`).
