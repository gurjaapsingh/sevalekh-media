# 📦 SevaLekh media robot (backup)

Every morning (India time) this makes the day's **ਮੁੱਖਵਾਕ pictures and videos** — the same cards phones draw, with SevaLekh's approved vyakhya — and publishes them on **GitHub Pages**. The app can then hand people ready-made files instead of making videos on their phones.

It is **free**: GitHub Actions and GitHub Pages cost nothing for a public repository. Nothing here touches Firebase, so SevaLekh stays on the free Spark plan.

What it makes, for each language in `LANGS` (default `pa,en,hi`):

| | |
|---|---|
| Pictures 9:16 and 4:5 | `mukhwak/pa/story-01.jpg …`, `mukhwak/pa/post-01.jpg …` |
| Videos 9:16 | `video-short.mp4` (1 min), `video-medium.mp4` (3 min), `video-full.mp4` (whole recording, 720p) — each under 44 MB |
| Index for the app | `mukhwak/latest.json` |
| A page for people | `index.html` |

## How it works

1. A headless browser opens `https://granth.web.app/#/mukhwak` and asks the page for its cards (`window.sevalekhMukhwak`, in `src/mediaBot.ts`). So the robot needs no keys and no copy of SevaLekh's data — it sees what any visitor sees.
2. It downloads SGPC's recording directly (no browser, so SGPC's CORS block doesn't matter).
3. ffmpeg turns cards + audio into the videos (the first card stays 30 s, as in the app).
4. The workflow publishes the result on GitHub Pages, replacing yesterday's.

It runs at 06:15, 08:00 and 10:30 India time; a later run does nothing once today's are published, and a run that's too early (MukhWak or audio not up yet) just fails and waits for the next one.

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

- `LANGS` — e.g. `pa,en,hi,pnb` (any language the MukhWak page offers that day)
- `APP_URL` — if SevaLekh moves to its own domain
- `AUDIO_RELAY` — your Cloudflare audio relay address (same as in SevaLekh's Admin), used only if SGPC turns the robot away

## Good to know

- **GitHub pauses scheduled workflows** in a repository with no activity for 60 days. If it stops, open Actions and re-enable it (or push any small change).
- **Limits:** GitHub Pages sites up to 1 GB, about 100 GB of downloads a month — far more than a day's files (roughly 60–80 MB for three languages).
- The **audio is SGPC's**. Sharing their recording is common, but if you also upload these videos to YouTube regularly, asking SGPC first is wise; YouTube may also flag the audio.
- To test locally: `npm install`, `npx playwright install chromium`, have `ffmpeg` installed, then `node make.mjs` (output in `site/`).
