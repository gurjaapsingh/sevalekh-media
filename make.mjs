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
 * 5. Optionally posts the day's video and text to a Telegram channel
 *    (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — see SOCIAL-AUTOPOST.md).
 *
 * Env: APP_URL (https://granth.web.app), LANGS (pa,en,hi), PAGES_URL (to skip
 * when today's are already published), FORCE=1 to make them again, POST=1 to
 * post to Telegram (scheduled runs, or "post" ticked on a manual run).
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
// Not 'networkidle': SevaLekh keeps a live Firebase connection open, so the
// network never goes quiet. Wait for the page's own "ready" instead.
page.on('console', (m) => { if (m.type() === 'error') console.warn('page console:', m.text()); });
await page.goto(`${APP}/#/mukhwak`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
try {
  await page.waitForFunction(() => window.sevalekhMukhwak && window.sevalekhMukhwak.ready, null, { timeout: 120_000 });
} catch {
  // The vyakhya didn't finish loading in time: go on with what the page has
  // (Gurbani, teeka) rather than make nothing — if the page has the MukhWak at all.
  const has = await page.evaluate(() => !!window.sevalekhMukhwak);
  if (!has) {
    console.error('The MukhWak page never got ready. Page text:\n' + (await page.evaluate(() => document.body.innerText.slice(0, 800))));
    process.exit(1);
  }
  console.warn('Vyakhya still loading after 2 min — making the media with what is there.');
}
const info = await page.evaluate(() => {
  const m = window.sevalekhMukhwak;
  return { date: m.date, ang: m.ang, langs: m.langs, audioUrl: m.audioUrl, bot: m.bot || { fullRes: 1080, speeds: [] } };
});
log(`Admin's robot settings as the page sees them: ${JSON.stringify(info.bot)}`);
const day = `${info.date.year}-${String(info.date.month).padStart(2, '0')}-${String(info.date.day).padStart(2, '0')}`;
log(`MukhWak ${day}, Ang ${info.ang}; languages on the page: ${info.langs.join(', ')}`);
// Admin → 2 · MukhWak → What the robot makes
const FULL_RES = info.bot.fullRes === 720 ? 720 : 1080;
const SPEEDS = (info.bot.speeds || []).map(Number).filter((x) => x > 1 && x <= 4);
log(`Full video ${FULL_RES}p; sped-up versions: ${SPEEDS.length ? SPEEDS.map((x) => '×' + x).join(', ') : 'none'}`);
if (day !== indiaDate() && !FORCE) {
  console.error(`The page still shows ${day}, not ${indiaDate()} — too early. Will try again at the next run.`);
  process.exit(1);
}

// ── 2. SGPC's recording ──
const audioPath = path.resolve('audio.mp3');
// A normal browser's identity (SGPC's Cloudflare may turn away bare scripts),
// then the Admin's audio relay (repository variable AUDIO_RELAY) if that fails.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const relay = (process.env.AUDIO_RELAY || '').trim();
const audioTries = [info.audioUrl, ...(relay ? [relay.includes('{url}') ? relay.replace('{url}', encodeURIComponent(info.audioUrl)) : relay + encodeURIComponent(info.audioUrl)] : [])];
let audioBuf = null;
for (const u of audioTries) {
  try {
    const ar = await fetch(u, { headers: UA });
    if (ar.ok) { audioBuf = Buffer.from(await ar.arrayBuffer()); if (audioBuf.length > 10_000) break; audioBuf = null; }
    console.warn(`Audio ${u.startsWith(info.audioUrl) ? 'from SGPC' : 'via relay'}: HTTP ${ar.status}`);
  } catch (e) { console.warn(`Audio fetch failed: ${e.message}`); }
}
if (!audioBuf) { console.error('SGPC audio not available (not up yet, or blocked) — will try again at the next run.'); process.exit(1); }
await fs.writeFile(audioPath, audioBuf);
const audioSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath]).toString().trim());
log(`Audio: ${audioSec.toFixed(1)} s`);

const totals = Object.values(LENGTHS).map((s) => Math.min(s, audioSec));
const index = { date: day, ang: info.ang, made: new Date().toISOString(), langs: {} };

const texts = {};   // lang → the MukhWak as text messages, for Telegram
for (const lang of LANGS.filter((l) => info.langs.includes(l))) {
  const entry = { caption: await page.evaluate((c) => window.sevalekhMukhwak.caption(c), lang) };
  texts[lang] = await page.evaluate((c) => (window.sevalekhMukhwak.parts ? window.sevalekhMukhwak.parts(c) : []), lang);
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
      const bytes = await makeVideo(res.plans[k], images, T, path.join(DIR, file), { width: len === 'full' && T > 200 ? FULL_RES : 1080, long: len === 'full' && T > 200 });
      entry.story.videos[len] = { file, seconds: Math.round(T), bytes };
      log(`${lang} ${len}: ${Math.round(T)} s, ${(bytes / 1e6).toFixed(1)} MB`);
    }
    // Sped-up full videos: the full video's timeline, compressed; the audio
    // faster at the same pitch (ffmpeg atempo).
    const fullPlan = res.plans[names.indexOf('full')];
    for (const sp of SPEEDS) {
      const T = audioSec / sp;
      const plan = fullPlan.map((p) => ({ ...p, start: p.start / sp, end: p.end / sp }));
      const key = `full-x${sp}`;
      const file = `${lang}/video-${key}.mp4`;
      const bytes = await makeVideo(plan, images, T, path.join(DIR, file), { width: T > 200 ? FULL_RES : 1080, long: T > 200, speed: sp });
      entry.story.videos[key] = { file, seconds: Math.round(T), bytes, speed: sp };
      log(`${lang} ${key}: ${Math.round(T)} s, ${(bytes / 1e6).toFixed(1)} MB`);
    }
  }
  index.langs[lang] = entry;
}
await browser.close();

/** Slideshow + audio with ffmpeg; made again smaller if it comes out too big to share. */
async function makeVideo(plan, images, T, out, { width: w0 = 1080, long = false, speed = 1 } = {}) {
  const list = path.resolve('list.txt');
  const lines = [];
  for (const p of plan) {
    lines.push(`file '${path.join(DIR, images[p.card]).replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.1, p.end - p.start).toFixed(3)}`);
  }
  lines.push(`file '${path.join(DIR, images[plan[plan.length - 1].card])}'`);   // concat needs the last one twice
  await fs.writeFile(list, lines.join('\n'));
  const fade = Math.min(2.5, T * 0.1);
  let width = w0, crf = long ? (w0 >= 1080 ? 28 : 30) : 26, fps = long ? 6 : 24;
  // atempo takes at most 2× per step, so 2.5× is 2 × 1.25.
  const tempo = [];
  for (let left = speed; left > 1.0001;) { const f = Math.min(2, left); tempo.push(`atempo=${f.toFixed(4)}`); left /= f; }
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
      '-af', [...tempo, `afade=t=out:st=${Math.max(0, T - fade).toFixed(2)}:d=${fade.toFixed(2)}`].join(','),
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
  Object.entries(e.story?.videos ?? {}).map(([k, v]) => `<p><a href="${APP}/v/?d=${day}&l=${l}&k=${k}">🎬 ${k} · ${v.seconds}s · ${(v.bytes / 1e6).toFixed(1)} MB</a></p>`).join('') +
  `<p>${(e.story?.images ?? []).map((f) => `<a href="mukhwak/${f}"><img src="mukhwak/${f}" height="160" loading="lazy"></a>`).join(' ')}</p>`).join('');
await fs.writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>SevaLekh · ਮੁੱਖਵਾਕ ${day}</title><body style="font-family:sans-serif;max-width:60rem;margin:auto;padding:1rem">
<h1>ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ · ${day} · ਅੰਗ ${info.ang}</h1><p><a href="${APP}/#/mukhwak">${APP.replace(/^https?:\/\//, '')}</a></p>${links}</body>`);
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
await output('skip', 'false');

// ── 5. Telegram channel (optional) ──
// Secrets TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (@channel or -100…); variables
// TELEGRAM_LANG (pa), TELEGRAM_VIDEO (short; may be a list: short,full-x2.5),
// TELEGRAM_TEXT (1 = also the MukhWak as text, with the audio link; 0 = video only).
const TG = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();
if (process.env.TELEGRAM_TOKEN_IN_VARS) {
  console.warn('Telegram: the bot token is a repository VARIABLE, which anyone who can see the repository can read. Move it to Settings → Secrets and variables → Actions → Secrets (same name), then delete the variable.');
}
if (process.env.POST === '1' && TG && TG_CHAT) {
  try { await postTelegram(); } catch (e) { console.warn(`::warning::Telegram: ${e.message} — the files are published anyway.`); }
} else if (process.env.POST === '1') {
  const missing = [!TG && 'TELEGRAM_BOT_TOKEN', !TG_CHAT && 'TELEGRAM_CHAT_ID'].filter(Boolean).join(' and ');
  console.warn(`::warning::Telegram: not posting — ${missing} not found. Add it under the repository's Settings → Secrets and variables → Actions → *Secrets* tab → "New repository secret" (not Environment secrets, not Codespaces/Dependabot secrets).`);
} else if (TG && TG_CHAT) log('Telegram: not posting on this run (manual run without "post" ticked).');

async function postTelegram() {
  const lang = (process.env.TELEGRAM_LANG || LANGS[0] || 'pa').trim();
  const e = index.langs[lang];
  if (!e) throw new Error(`no media in "${lang}" today`);
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || 'HTTP ' + r.status}`);
  };
  const keys = (process.env.TELEGRAM_VIDEO || 'short').split(',').map((k) => k.trim()).filter(Boolean);
  let first = true;
  for (const k of keys) {
    const v = e.story?.videos?.[k] ?? (k === 'short' || k === 'medium' ? e.story?.videos?.full : undefined);
    if (!v) { console.warn(`Telegram: no "${k}" video today`); continue; }
    const f = new FormData();
    f.append('chat_id', TG_CHAT);
    f.append('video', new Blob([await fs.readFile(path.join(DIR, v.file))], { type: 'video/mp4' }), path.basename(v.file));
    f.append('width', '1080'); f.append('height', '1920');   // 9:16 — Telegram shows it tall, without black bars
    f.append('duration', String(v.seconds));
    f.append('supports_streaming', 'true');
    // The caption has no audio link: the video carries the audio. (Telegram allows 1,024 characters.)
    if (first && e.caption) f.append('caption', e.caption.slice(0, 1024));
    await call('sendVideo', f);
    log(`Telegram: sent ${lang} ${k} video`);
    first = false;
  }
  if (process.env.TELEGRAM_TEXT !== '0') {
    for (const t of texts[lang] ?? []) {
      const f = new FormData();
      f.append('chat_id', TG_CHAT); f.append('text', t);
      await call('sendMessage', f);
    }
    if (texts[lang]?.length) log(`Telegram: sent the MukhWak text in ${texts[lang].length} message(s)`);
  }
}
log('Done.');
