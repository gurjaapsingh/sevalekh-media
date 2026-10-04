/**
 * 📦 SevaLekh media robot — makes the day's MukhWak pictures and videos.
 *
 * 1. Opens SevaLekh's own MukhWak page in a headless browser and asks it
 *    (window.sevalekhMukhwak, src/mediaBot.ts) for the cards — the same
 *    pictures phones draw, with SevaLekh's approved vyakhya.
 * 2. Downloads SGPC's recording (no browser here, so no CORS problem).
 * 3. ffmpeg turns the cards + audio into videos, 9:16 and 4:5: the first 1 and
 *    2 minutes (at 1.5×), the whole MukhWak, and the whole sped up to fit
 *    3 minutes — each kept under 44 MB so phones can share them.
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
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { meaningsFingerprint, mukhwakAngs } from './fingerprint.mjs';

const APP = (process.env.APP_URL || 'https://granth.web.app').replace(/\/+$/, '');
const LANGS = (process.env.LANGS || 'pa,en,pnb,hi').split(',').map((s) => s.trim()).filter(Boolean);
const PAGES = (process.env.PAGES_URL || '').replace(/\/+$/, '');
const FORCE = !!process.env.FORCE;
const OUT = path.resolve('site');
const DIR = path.join(OUT, 'mukhwak');
const LIMIT = 44 * 1024 * 1024;
// Chopped videos: the first 1 and 2 minutes, at the Admin's chop speed (1.5× by default).
// The start of the MukhWak: 1 minute (Shorts, TikTok, status) and 90 s (Reels' classic limit).
const CHOPS = { short: 60, reel: 90 };
// ffmpeg jobs at once — GitHub's runners have 4 cores.
const PARALLEL = 3;
// "fit": the whole MukhWak sped up just enough to fit a 3-minute Short / Reel.
const FIT_SECONDS = 179;   // 2:59 — safely under YouTube Shorts' 3 minutes
// Full videos (and those made from them): the title card stays 25 s, and there is no
// closing card — the recording is still playing there, and players loop to the start.
const FULL_TITLE = 25;

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
  return { date: m.date, ang: m.ang, langs: m.langs, audioUrl: m.audioUrl, bot: m.bot || {} };
});
log(`Admin's robot settings as the page sees them: ${JSON.stringify(info.bot)}`);
const day = `${info.date.year}-${String(info.date.month).padStart(2, '0')}-${String(info.date.day).padStart(2, '0')}`;
log(`MukhWak ${day}, Ang ${info.ang}; languages on the page: ${info.langs.join(', ')}`);
// Admin → 2 · MukhWak → What the robot makes
const FULL_RES = info.bot.fullRes === 720 ? 720 : 1080;
// Four videos per size and language: 1 min, 90 s, the whole MukhWak, and the whole in 2:59.
const CHOP_SPEED = [1, 1.25, 1.5, 2].includes(Number(info.bot.chopSpeed)) ? Number(info.bot.chopSpeed) : 1.5;
const FIT = info.bot.fit !== false;                 // default on
const POST_VIDEOS = info.bot.postVideos !== false;  // 4:5 videos too (default on)
log(`Full video ${FULL_RES}p; 1-min and 90-s videos at ×${CHOP_SPEED}; whole-in-2:59 ${FIT ? 'on' : 'off'}; 4:5 videos ${POST_VIDEOS ? 'on' : 'off'}`);
if (day !== indiaDate() && !FORCE) {
  console.error(`The page still shows ${day}, not ${indiaDate()} — too early. Will try again at the next run.`);
  process.exit(1);
}

// SGPC's own Nanakshahi date from its MukhWak page ("੧੮ ਅੱਸੂ (ਸੰਮਤ ੫੫੮ ਨਾਨਕਸ਼ਾਹੀ)"),
// handed to the page so the pictures carry exactly SGPC's date.
try {
  const r = await fetch('https://hs.sgpc.net/index.php', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36' }, signal: AbortSignal.timeout(20_000) });
  // NFD on both sides: SGPC writes ਸ਼ as ਸ + ਼ (and the like).
  const t = (await r.text()).normalize('NFD').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const months = ['ਚੇਤ', 'ਵੈਸਾਖ', 'ਜੇਠ', 'ਹਾੜ', 'ਸਾਵਣ', 'ਭਾਦੋਂ', 'ਅੱਸੂ', 'ਕੱਤਕ', 'ਮੱਘਰ', 'ਪੋਹ', 'ਮਾਘ', 'ਫੱਗਣ'].map((m) => m.normalize('NFD'));
  const num = (x) => Number(x.replace(/[੦-੯]/g, (c) => String('੦੧੨੩੪੫੬੭੮੯'.indexOf(c))));
  const mm = t.match(new RegExp(`([੦-੯0-9]{1,2})\\s+(${months.join('|')})[^()]{0,20}\\(\\s*${'ਸੰਮਤ'.normalize('NFD')}\\s+([੦-੯0-9]{3})\\s+${'ਨਾਨਕ'.normalize('NFD')}`));
  // Only when SGPC's page shows the same MukhWak (its Ang matches).
  const angOk = new RegExp(`${'ਅੰਗ'.normalize('NFD')}:?\\s*${String(info.ang).replace(/[0-9]/g, (c) => '੦੧੨੩੪੫੬੭੮੯'[c])}`).test(t);
  if (mm && angOk) {
    const fix = { g: day, day: num(mm[1]), month: months.indexOf(mm[2]), year: num(mm[3]) };
    await page.evaluate((f) => window.sevalekhMukhwak.setNanakshahi?.(f), fix);
    log(`Nanakshahi date from SGPC: ${mm[1]} ${mm[2]} (ਸੰਮਤ ${mm[3]})`);
  } else log('Nanakshahi date: SGPC\'s page didn\'t match today — using SevaLekh\'s own reckoning.');
} catch (e) { log(`Nanakshahi date: couldn't read SGPC's page (${e.message}) — using SevaLekh's own reckoning.`); }

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

// Lengths asked of the page, in seconds of the RECORDING: the chops' audio span, and the whole.
const chopKeys = Object.keys(CHOPS).filter((k) => CHOPS[k] * CHOP_SPEED < audioSec);
const totals = [...chopKeys.map((k) => CHOPS[k] * CHOP_SPEED), audioSec];
// Today's approved meanings, fingerprinted: the quick check makes everything
// again later in the day if they change (an edit or a new approval).
const fingerprint = await meaningsFingerprint(await mukhwakAngs(info.date.year, info.date.month, info.date.day));
const index = { date: day, ang: info.ang, made: new Date().toISOString(), fingerprint, langs: {} };

/** Plan timings scaled into a video `speed` times faster. */
const scale = (plan, speed) => plan.map((p) => ({ ...p, start: p.start / speed, end: p.end / speed }));

/**
 * The full video's plan with a 25 s title card and no closing card: the body
 * cards are stretched, in proportion, over everything after the title.
 */
function fullPlan(plan, T) {
  const body = plan.filter((p, i) => i > 0 && i < plan.length - 1);
  if (!body.length) return plan;
  const title = Math.min(FULL_TITLE, T * 0.4);
  const from = body[0].start, to = body[body.length - 1].end;
  const k = (T - title) / Math.max(1, to - from);
  return [{ ...plan[0], start: 0, end: title },
    ...body.map((p) => ({ ...p, start: title + (p.start - from) * k, end: title + (p.end - from) * k }))];
}

const texts = {};   // lang → the MukhWak as text messages, for Telegram
const videoJobs = [];   // ffmpeg work, run after all the pictures are drawn
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

    // A wide (1200×630) link-preview picture for SevaLekh's video pages (/v/…): the
    // first 4:5 card whole, on a blurred copy of itself. Facebook, WhatsApp and X crop
    // tall pictures to this shape.
    if (fmt === 'post' && images.length) {
      const prev = `${lang}/preview.jpg`;
      const hasWide = await page.evaluate(() => typeof window.sevalekhMukhwak.wide === 'function');
      if (hasWide) {
        // Drawn by the page itself: "ਮੁੱਖਵਾਕ · date", the opening Gurbani, granth.web.app.
        const save = async (name, w, h) => fs.writeFile(path.join(DIR, name),
          Buffer.from((await page.evaluate(([c, ww, hh]) => window.sevalekhMukhwak.wide(c, ww, hh), [lang, w, h])).split(',')[1], 'base64'));
        await save(prev, 1200, 630);
        await save(`${lang}/thumb.jpg`, 1280, 720);      // YouTube video thumbnail
        entry.thumb = `${lang}/thumb.jpg`;
      } else {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(DIR, images[0]), '-filter_complex',
          '[0]scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630,boxblur=30:2,eq=brightness=-0.06[bg];' +
          '[0]scale=-2:630[fg];[bg][fg]overlay=(W-w)/2:0', '-q:v', '3', path.join(DIR, prev)]);
      }
      entry.preview = prev;
    }

    // ── 3. Videos: 9:16 (Reels, Shorts, TikTok, status) and 4:5 (Instagram / Facebook feed) ──
    if (fmt === 'post' && !POST_VIDEOS) continue;
    const videos = entry[fmt].videos = {};
    const tag = fmt === 'story' ? '' : '-4x5';
    // Queued now, made all together after the pictures (several at once — see PARALLEL).
    const make = (key, plan, T, speed, long) => videoJobs.push(async () => {
      const file = `${lang}/video${tag}-${key}.mp4`;
      const bytes = await makeVideo(plan, images, T, path.join(DIR, file), { width: long ? FULL_RES : 1080, long, speed });
      videos[key] = { file, seconds: Math.round(T), bytes, ...(speed !== 1 ? { speed: Math.round(speed * 100) / 100 } : {}) };
      log(`${lang} ${fmt} ${key}: ${Math.round(T)} s${speed !== 1 ? ` at ×${videos[key].speed}` : ''}, ${(bytes / 1e6).toFixed(1)} MB`);
    });
    // 1 minute and 90 s: the start of the MukhWak, at the chop speed (with the closing card).
    for (let i = 0; i < chopKeys.length; i++) {
      const k = chopKeys[i];
      make(k, scale(res.plans[i], CHOP_SPEED), CHOPS[k], CHOP_SPEED, false);
    }
    // The whole MukhWak at normal speed.
    const full = fullPlan(res.plans[res.plans.length - 1], audioSec);
    make('full', full, audioSec, 1, audioSec > 200);
    // The whole MukhWak sped up just enough for a 3-minute Short / Reel.
    if (FIT && audioSec > FIT_SECONDS) {
      const sp = Math.ceil((audioSec / FIT_SECONDS) * 100) / 100;
      make('fit', scale(full, sp), audioSec / sp, sp, audioSec / sp > 200);
    }
  }
  index.langs[lang] = entry;
}
await browser.close();

// ── The videos: several ffmpeg runs at once ──
{
  const t0 = Date.now();
  let next = 0;
  const worker = async () => { while (next < videoJobs.length) await videoJobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, videoJobs.length) }, worker));
  log(`${videoJobs.length} videos in ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Slideshow + audio with ffmpeg; made again smaller if it comes out too big to share. */
async function makeVideo(plan, images, T, out, { width: w0 = 1080, long = false, speed = 1 } = {}) {
  const list = `${out}.txt`;   // one list per video: several are made at once
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
    await ffmpeg([
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', audioPath,
      '-t', T.toFixed(2),
      '-map', '0:v', '-map', '1:a',
      '-vf', `scale=${width}:-2:flags=lanczos,fps=${fps},format=yuv420p`,
      // veryfast: still pictures gain little from slower presets, and it's several times quicker.
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', String(crf),
      '-maxrate', String(maxrate), '-bufsize', String(maxrate * 2),
      '-c:a', 'aac', '-b:a', '96k',
      '-af', [...tempo, `afade=t=out:st=${Math.max(0, T - fade).toFixed(2)}:d=${fade.toFixed(2)}`].join(','),
      '-movflags', '+faststart',
      out,
    ]);
    const { size } = await fs.stat(out);
    if (size <= LIMIT) { await fs.rm(list, { force: true }); return size; }
    log(`${path.basename(out)} is ${(size / 1e6).toFixed(1)} MB — making it smaller`);
    width = Math.min(width, 540); crf += 4; fps = Math.min(fps, 4);
  }
  await fs.rm(list, { force: true });
  return (await fs.stat(out)).size;
}

/** ffmpeg without blocking, so several can run at once. */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1 << 24 }, (err, _out, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr || err.message}`)) : resolve()));
  });
}

// ── 4. The index the app reads, and a small page for people ──
await fs.writeFile(path.join(DIR, 'latest.json'), JSON.stringify(index, null, 1));
const links = Object.entries(index.langs).map(([l, e]) => `<h2>${l}</h2>` +
  Object.entries(e.story?.videos ?? {}).map(([k, v]) => `<p><a href="${APP}/v/${l}/${k}/?d=${day}">🎬 9:16 ${k}${v.speed ? ' ×' + v.speed : ''} · ${v.seconds}s · ${(v.bytes / 1e6).toFixed(1)} MB</a></p>`).join('') +
  Object.entries(e.post?.videos ?? {}).map(([k, v]) => `<p><a href="mukhwak/${v.file}">🎬 4:5 ${k}${v.speed ? ' ×' + v.speed : ''} · ${v.seconds}s · ${(v.bytes / 1e6).toFixed(1)} MB</a></p>`).join('') +
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
