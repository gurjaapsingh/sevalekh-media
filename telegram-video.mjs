/**
 * 🤖 A MukhWak video made to order for the Telegram bot (telegram-bot/worker.js):
 * any length, speed, shape and size — from the day's whole video already on
 * GitHub Pages, so no browser and no new pictures are needed (about a minute).
 *
 * Run by .github/workflows/telegram-video.yml, which the bot starts when someone
 * asks for something the robot hasn't made ready (e.g. "@bot 1.25x 2:00 720p").
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN, PAGES_URL
 *   CHAT_ID, REPLY_TO      where to send it (and the message it answers)
 *   LANG                   pa / en / pnb / hi
 *   FMT                    story (9:16) · post (4:5) · wide (16:9)
 *   SECONDS                the length wanted (0 or empty: the whole MukhWak)
 *   SPEED                  ×speed, pitch kept (empty: ×1.6 when cut to a length, else ×1)
 *   RES                    1080 / 720 / 480 — the short side
 *   LABEL                  what was asked for (in the caption), e.g. "📸 Insta Story"
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const TOKEN = env('TELEGRAM_BOT_TOKEN').replace(/\s+/g, '').replace(/^bot(?=\d)/i, '');
const PAGES = env('PAGES_URL').replace(/\/+$/, '');
const CHAT = env('CHAT_ID');
const REPLY = Number(env('REPLY_TO', '0')) || 0;
const LANG = env('LANG', 'pa');
const FMT = ['story', 'post', 'wide'].includes(env('FMT')) ? env('FMT') : 'story';
const WANT = Math.max(0, Number(env('SECONDS', '0')) || 0);
const SPEED = Math.min(3, Math.max(0.5, Number(env('SPEED')) || (WANT ? 1.6 : 1)));
const RES = [1080, 720, 480, 360].includes(Number(env('RES'))) ? Number(env('RES')) : 1080;
const LABEL = env('LABEL');
const LIMIT = 48 * 1024 * 1024;   // bots may upload 50 MB
const CLOSING = 3;                // seconds of the closing card kept at the end of a cut video

const log = (...a) => console.log('•', ...a);
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
};
const say = (text) => {
  const f = new FormData();
  f.append('chat_id', CHAT); f.append('text', text);
  if (REPLY) f.append('reply_parameters', JSON.stringify({ message_id: REPLY, allow_sending_without_reply: true }));
  return tg('sendMessage', f).catch((e) => console.warn(e.message));
};
const ffmpeg = (args) => new Promise((ok, bad) => execFile('ffmpeg', args, { maxBuffer: 1 << 24 }, (e, _o, err) => (e ? bad(new Error(err || e.message)) : ok())));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

try {
  if (!TOKEN || !CHAT || !PAGES) throw new Error('TELEGRAM_BOT_TOKEN, CHAT_ID and PAGES_URL are needed');
  const ix = await fetch(`${PAGES}/mukhwak/latest.json`, { cache: 'no-store' }).then((r) => r.json());
  const e = ix.langs?.[LANG] ?? ix.langs?.pa ?? Object.values(ix.langs ?? {})[0];
  if (!e) throw new Error('no MukhWak media today yet');
  // The whole MukhWak in the shape asked for (16:9 / 4:5 off on the robot: 9:16).
  const src = e[FMT]?.videos?.full ?? e.story?.videos?.full;
  const fmt = e[FMT]?.videos?.full ? FMT : 'story';
  if (!src) throw new Error('no whole video today yet');
  log(`${LANG} ${fmt}: ${src.file} → ${WANT ? `${WANT} s` : 'whole'} at ×${SPEED}, ${RES}p`);
  const inFile = path.resolve('src.mp4');
  await fs.writeFile(inFile, Buffer.from(await (await fetch(`${PAGES}/mukhwak/${src.file}`)).arrayBuffer()));
  const D = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inFile]).toString().trim());
  const whole = D / SPEED;
  const T = WANT ? Math.min(WANT, whole) : whole;
  const cut = T < whole - 1;
  // atempo takes at most 2× (and at least 0.5×) per step.
  const tempo = [];
  for (let left = SPEED; Math.abs(left - 1) > 0.0001;) { const f = Math.min(2, Math.max(0.5, left)); tempo.push(`atempo=${f.toFixed(4)}`); left /= f; }
  const fade = Math.min(2.5, T * 0.1);
  // The short side at RES (9:16 / 4:5: the width; 16:9: the height).
  const scaleTo = (r) => `scale='if(gt(iw,ih),-2,${r})':'if(gt(iw,ih),${r},-2)':flags=lanczos`;
  const out = path.resolve('out.mp4');
  let res = RES, crf = 26;
  for (let attempt = 0; attempt < 3; attempt++) {
    const maxrate = Math.max(150_000, Math.round((LIMIT * 8 * 0.85) / T - 96_000));
    // A cut video ends on the closing card (SevaLekh's link), taken from the whole video's end.
    const vf = cut
      ? `[0:v]split[a][b];[a]setpts=(PTS-STARTPTS)/${SPEED},trim=duration=${Math.max(1, T - CLOSING).toFixed(2)},setpts=PTS-STARTPTS[m];` +
        `[b]trim=start=${Math.max(0, D - CLOSING).toFixed(2)},setpts=PTS-STARTPTS[c];[m][c]concat=n=2:v=1:a=0,${scaleTo(res)},fps=24,format=yuv420p[v]`
      : `[0:v]setpts=PTS/${SPEED},${scaleTo(res)},fps=24,format=yuv420p[v]`;
    const af = `[0:a]${[...tempo, `atrim=0:${T.toFixed(2)}`, `afade=t=out:st=${Math.max(0, T - fade).toFixed(2)}:d=${fade.toFixed(2)}`].join(',')}[aout]`;
    await ffmpeg(['-y', '-loglevel', 'error', '-i', inFile, '-filter_complex', `${vf};${af}`, '-map', '[v]', '-map', '[aout]',
      '-t', T.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', String(crf),
      '-maxrate', String(maxrate), '-bufsize', String(maxrate * 2), '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
    const { size } = await fs.stat(out);
    log(`made ${mmss(T)}, ${(size / 1e6).toFixed(1)} MB at ${res}p`);
    if (size <= LIMIT) break;
    res = Math.min(res, 540); crf += 4;
  }
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim().split(',').map(Number);
  const shape = fmt === 'wide' ? '16:9' : fmt === 'post' ? '4:5' : '9:16';
  const f = new FormData();
  f.append('chat_id', CHAT);
  f.append('video', new Blob([await fs.readFile(out)], { type: 'video/mp4' }), `mukhwak-${ix.date}-${LANG}-${shape.replace(':', 'x')}-${Math.round(T)}s.mp4`);
  f.append('width', String(w)); f.append('height', String(h));
  f.append('duration', String(Math.round(T)));
  f.append('supports_streaming', 'true');
  f.append('caption', `ਮੁੱਖਵਾਕ ${ix.date} · ${LABEL ? `${LABEL} · ` : ''}${shape} · ${mmss(T)}${SPEED !== 1 ? ` · ×${SPEED}` : ''} · ${h > w ? w : h}p\nsevalekh.com`);
  if (REPLY) f.append('reply_parameters', JSON.stringify({ message_id: REPLY, allow_sending_without_reply: true }));
  await tg('sendVideo', f);
  log('sent');
} catch (err) {
  console.error(err);
  await say(`⚠ ਵੀਡੀਓ ਨਹੀਂ ਬਣ ਸਕੀ · Couldn't make the video: ${String(err.message || err).slice(0, 300)}`);
  process.exit(1);
}
