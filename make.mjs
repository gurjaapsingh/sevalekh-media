/**
 * 📦 SevaLekh media robot — makes the day's MukhWak pictures and videos.
 *
 * 1. Opens SevaLekh's own MukhWak page in a headless browser and asks it
 *    (window.sevalekhMukhwak, src/mediaBot.ts) for the cards — the same
 *    pictures phones draw, with SevaLekh's approved vyakhya.
 * 2. Downloads SGPC's recording (no browser here, so no CORS problem).
 * 3. ffmpeg turns the cards + audio into 1-minute, 3-minute and full videos,
 *    each kept under 44 MB so phones can share them.
 * 4. Writes site/mukhwak/latest.json (read by the app) and the files; the
 *    workflow publishes site/ on GitHub Pages.
 *
 * Env: APP_URL (https://granth.web.app), LANGS (pa,en,hi), PAGES_URL (to skip
 * when today's are already published), FORCE=1 to make them again.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const APP = (process.env.APP_URL || 'https://granth.web.app').replace(/\/+$/, '');
const LANGS = (process.env.LANGS || 'pa,en,hi').split(',').map((s) => s.trim()).filter(Boolean);
const PAGES = (process.env.PAGES_URL || '').replace(/\/+$/, '');
const FORCE = !!process.env.FORCE;
const OUT = path.resolve('site');
const DIR = path.join(OUT, 'mukhwak');
const LIMIT = 44 * 1024 * 1024;
const LENGTHS = { short: 60, medium: 180, full: Infinity };

const log = (...a) => console.log('•', ...a);
const output = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

function indiaDate() {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── Already done today? ──
if (PAGES && !FORCE) {
  try {
    const r = await fetch(`${PAGES}/mukhwak/latest.json`, { cache: 'no-store' });
    if (r.ok && (await r.json()).date === indiaDate()) {
      log(`Today's (${indiaDate()}) are already published — nothing to do.`);
      await output('skip', 'true');
      process.exit(0);
    }
  } catch { /* not published yet */ }
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(DIR, { recursive: true });

// ── 1. The cards, from SevaLekh itself ──
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('page error:', e.message));
await page.goto(`${APP}/#/mukhwak`, { waitUntil: 'networkidle', timeout: 120_000 });
await page.waitForFunction(() => window.sevalekhMukhwak && window.sevalekhMukhwak.ready, null, { timeout: 120_000 });
const info = await page.evaluate(() => {
  const m = window.sevalekhMukhwak;
  return { date: m.date, ang: m.ang, langs: m.langs, audioUrl: m.audioUrl };
});
const day = `${info.date.year}-${String(info.date.month).padStart(2, '0')}-${String(info.date.day).padStart(2, '0')}`;
log(`MukhWak ${day}, Ang ${info.ang}; languages on the page: ${info.langs.join(', ')}`);
if (day !== indiaDate() && !FORCE) {
  console.error(`The page still shows ${day}, not ${indiaDate()} — too early. Will try again at the next run.`);
  process.exit(1);
}

// ── 2. SGPC's recording ──
const audioPath = path.resolve('audio.mp3');
const ar = await fetch(info.audioUrl);
if (!ar.ok) { console.error(`SGPC audio not up yet (${ar.status}) — will try again at the next run.`); process.exit(1); }
await fs.writeFile(audioPath, Buffer.from(await ar.arrayBuffer()));
const audioSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath]).toString().trim());
log(`Audio: ${audioSec.toFixed(1)} s`);

const totals = Object.values(LENGTHS).map((s) => Math.min(s, audioSec));
const index = { date: day, ang: info.ang, made: new Date().toISOString(), langs: {} };

for (const lang of LANGS.filter((l) => info.langs.includes(l))) {
  const entry = { caption: await page.evaluate((c) => window.sevalekhMukhwak.caption(c), lang) };
  await fs.mkdir(path.join(DIR, lang), { recursive: true });

  for (const fmt of ['story', 'post']) {
    const res = await page.evaluate(([c, f, t]) => window.sevalekhMukhwak.render(c, f, t), [lang, fmt, totals]);
    const images = [];
    for (let i = 0; i < res.images.length; i++) {
      const name = `${lang}/${fmt}-${String(i + 1).padStart(2, '0')}.jpg`;
      await fs.writeFile(path.join(DIR, name), Buffer.from(res.images[i].split(',')[1], 'base64'));
      images.push(name);
    }
    entry[fmt] = { images };
    log(`${lang} ${fmt}: ${images.length} pictures`);

    // ── 3. Videos (tall format only) ──
    if (fmt !== 'story') continue;
    entry.story.videos = {};
    const names = Object.keys(LENGTHS);
    for (let k = 0; k < names.length; k++) {
      const len = names[k];
      const T = totals[k];
      if (len !== 'full' && LENGTHS[len] >= audioSec) continue;   // the recording is shorter: “full” covers it
      const file = `${lang}/video-${len}.mp4`;
      const bytes = await makeVideo(res.plans[k], images, T, path.join(DIR, file), len === 'full' && T > 200);
      entry.story.videos[len] = { file, seconds: Math.round(T), bytes };
      log(`${lang} ${len}: ${Math.round(T)} s, ${(bytes / 1e6).toFixed(1)} MB`);
    }
  }
  index.langs[lang] = entry;
}
await browser.close();

/** Slideshow + audio with ffmpeg; made again smaller if it comes out too big to share. */
async function makeVideo(plan, images, T, out, long) {
  const list = path.resolve('list.txt');
  const lines = [];
  for (const p of plan) {
    lines.push(`file '${path.join(DIR, images[p.card]).replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.1, p.end - p.start).toFixed(3)}`);
  }
  lines.push(`file '${path.join(DIR, images[plan[plan.length - 1].card])}'`);   // concat needs the last one twice
  await fs.writeFile(list, lines.join('\n'));
  const fade = Math.min(2.5, T * 0.1);
  let width = long ? 720 : 1080, crf = long ? 30 : 26, fps = long ? 6 : 24;
  for (let attempt = 0; attempt < 3; attempt++) {
    const maxrate = Math.max(100_000, Math.round((LIMIT * 8 * 0.85) / T - 96_000));
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', audioPath,
      '-t', T.toFixed(2),
      '-map', '0:v', '-map', '1:a',
      '-vf', `scale=${width}:-2:flags=lanczos,fps=${fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', String(crf),
      '-maxrate', String(maxrate), '-bufsize', String(maxrate * 2),
      '-c:a', 'aac', '-b:a', '96k',
      '-af', `afade=t=out:st=${Math.max(0, T - fade).toFixed(2)}:d=${fade.toFixed(2)}`,
      '-movflags', '+faststart',
      out,
    ], { stdio: 'inherit' });
    const { size } = await fs.stat(out);
    if (size <= LIMIT) return size;
    log(`${path.basename(out)} is ${(size / 1e6).toFixed(1)} MB — making it smaller`);
    width = Math.min(width, 540); crf += 4; fps = Math.min(fps, 4);
  }
  return (await fs.stat(out)).size;
}

// ── 4. The index the app reads, and a small page for people ──
await fs.writeFile(path.join(DIR, 'latest.json'), JSON.stringify(index, null, 1));
const links = Object.entries(index.langs).map(([l, e]) => `<h2>${l}</h2>` +
  Object.entries(e.story?.videos ?? {}).map(([k, v]) => `<p><a href="mukhwak/${v.file}">🎬 ${k} · ${v.seconds}s · ${(v.bytes / 1e6).toFixed(1)} MB</a></p>`).join('') +
  `<p>${(e.story?.images ?? []).map((f) => `<a href="mukhwak/${f}"><img src="mukhwak/${f}" height="160" loading="lazy"></a>`).join(' ')}</p>`).join('');
await fs.writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>SevaLekh · ਮੁੱਖਵਾਕ ${day}</title><body style="font-family:sans-serif;max-width:60rem;margin:auto;padding:1rem">
<h1>ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ · ${day} · ਅੰਗ ${info.ang}</h1><p><a href="${APP}/#/mukhwak">${APP.replace(/^https?:\/\//, '')}</a></p>${links}</body>`);
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
await output('skip', 'false');
log('Done.');
