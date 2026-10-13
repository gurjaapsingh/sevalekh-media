/**
 * 🤖 SevaLekh MukhWak Telegram bot — a Cloudflare Worker (free plan is plenty).
 *
 * Tag the bot in a group (@yourbot), message it, or type "@yourbot " in ANY chat
 * (inline mode) and it offers today's MukhWak video for each place it goes:
 *
 *   📸 Insta Story · 📸 Insta Reel · 📘 FB Reel · 📘 FB Story · 📘 FB feed 16:9
 *   ▶️ YouTube Short · ▶️ YouTube 16:9 · 🎵 TikTok · 💬 WhatsApp Status
 *   🖼 Insta / FB post 4:5 · 𝕏 X 16:9 · 📖 the whole MukhWak
 *
 * with the language (ਪੰਜਾਬੀ / English / شاہمکھی / हिंदी) and size (1080p / 720p / 480p).
 * The daily robot's ready videos (GitHub Pages, make.mjs) are sent at once.
 * Anything else — "@yourbot 1.25x 2:00", "reel 45s 16:9 720p en", "2x" — is made to
 * order by a GitHub Action (telegram-video.mjs) and arrives in about a minute.
 * Chopped (cut-short) videos are ×1.6 unless another speed is asked for.
 *
 * Setup: telegram-bot/README.md. Settings (Worker → Settings → Variables):
 *   BOT_TOKEN       (secret) the bot's token from @BotFather — the same bot as the robot's
 *   WEBHOOK_SECRET  (secret) any long random text; also unlocks /setup
 *   PAGES_URL       https://<owner>.github.io/sevalekh-media
 *   GH_TOKEN        (secret, optional) fine-grained token, this repository, "Actions: read and write"
 *                   — for videos made to order; without it, only the ready ones are offered
 *   GH_REPO         <owner>/sevalekh-media
 *   GH_REF          main (the branch with telegram-video.yml)
 *   CACHE           (KV namespace binding, optional) remembers sent videos, so the same one
 *                   goes again instantly, and slows down anyone asking too often
 */

const LANGS = [['pa', 'ਪੰਜਾਬੀ'], ['en', 'English'], ['pnb', 'شاہمکھی'], ['hi', 'हिंदी']];
const RESES = [1080, 720, 480];
/**
 * Where it goes → which video: shape (story 9:16 · post 4:5 · wide 16:9), the robot's
 * ready one (key), and the length that place takes (sec; 0 = the whole MukhWak).
 */
const PRESETS = {
  igs: { label: '📸 Insta Story', fmt: 'story', key: 'min', sec: 60 },
  igr: { label: '📸 Insta Reel', fmt: 'story', key: 'reel', sec: 90 },
  fbr: { label: '📘 FB Reel', fmt: 'story', key: 'reel', sec: 90 },
  fbs: { label: '📘 FB Story', fmt: 'story', key: 'min', sec: 60 },
  yts: { label: '▶️ YouTube Short', fmt: 'story', key: 'fit', sec: 179, whole: true },
  ytw: { label: '▶️ YouTube 16:9', fmt: 'wide', key: 'full', sec: 0 },
  tt: { label: '🎵 TikTok', fmt: 'story', key: 'reel', sec: 90 },
  wa: { label: '💬 WhatsApp Status', fmt: 'story', key: 'reel', sec: 90 },
  feed: { label: '🖼 Insta / FB post 4:5', fmt: 'post', key: 'feed', sec: 140 },
  fbw: { label: '📘 FB feed 16:9', fmt: 'wide', key: 'full', sec: 0 },
  x: { label: '𝕏 X / Twitter 16:9', fmt: 'wide', key: 'feed', sec: 140 },
  full: { label: '📖 ਪੂਰਾ · Whole 9:16', fmt: 'story', key: 'full', sec: 0 },
};
const ORDER = ['igs', 'igr', 'fbr', 'fbs', 'yts', 'ytw', 'tt', 'wa', 'feed', 'fbw', 'x', 'full'];
const CHOP_SPEED = 1.6;
const SHAPE = { story: '9:16', post: '4:5', wide: '16:9' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/setup') return setup(url, env);
    if (req.method !== 'POST') return new Response('SevaLekh MukhWak bot ✓');
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
    const u = await req.json().catch(() => null);
    // Answer Telegram at once; the work carries on.
    if (u) ctx.waitUntil(handle(u, env).catch((e) => console.error(e)));
    return new Response('ok');
  },
};

/** GET /setup?key=WEBHOOK_SECRET — points Telegram at this Worker and sets the bot's commands. */
async function setup(url, env) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('add ?key=<WEBHOOK_SECRET>', { status: 403 });
  const hook = `${url.origin}/`;
  const a = await api(env, 'setWebhook', { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query', 'inline_query'] });
  const b = await api(env, 'setMyCommands', { commands: [
    { command: 'mukhwak', description: "ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ — today's MukhWak videos" },
    { command: 'help', description: 'ਕਿਵੇਂ ਵਰਤਣਾ · how to use' },
  ] });
  const me = await api(env, 'getMe', {});
  return new Response(JSON.stringify({ webhook: a, commands: b, bot: me.result?.username }, null, 1), { headers: { 'content-type': 'application/json' } });
}

async function api(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) console.warn(method, j.description);
  return j;
}

let meCache = null;
async function me(env) {
  if (!meCache) meCache = (await api(env, 'getMe', {})).result ?? {};
  return meCache;
}

let ixCache = { at: 0, ix: null };
/** Today's index from the robot (cached 5 minutes). */
async function today(env) {
  if (ixCache.ix && Date.now() - ixCache.at < 300_000) return ixCache.ix;
  const r = await fetch(`${env.PAGES_URL.replace(/\/+$/, '')}/mukhwak/latest.json?t=${Math.floor(Date.now() / 300_000)}`);
  const ix = r.ok ? await r.json() : null;
  ixCache = { at: Date.now(), ix };
  return ix;
}
const fileUrl = (env, f) => `${env.PAGES_URL.replace(/\/+$/, '')}/mukhwak/${f}`;

/** The robot's ready video for a preset (or null: to be made to order). */
function ready(ix, lang, p) {
  const vids = ix?.langs?.[lang]?.[p.fmt]?.videos;
  if (!vids) return null;
  if (p.key === 'fit') return vids.fit ?? vids.full ?? null;   // the whole MukhWak fits 3 minutes anyway
  // A short MukhWak: the robot skips lengths the whole one already fits.
  const fits = vids.full && vids.full.seconds <= p.sec ? vids.full : null;
  // 'feed' (2:20) is new: an older day's index has the 90-s 'reel' there.
  return vids[p.key] ?? (p.key === 'feed' ? vids.reel : null) ?? fits ?? null;
}

/* ── Updates ─────────────────────────────────────────────────────────── */

async function handle(u, env) {
  if (u.inline_query) return inline(u.inline_query, env);
  if (u.callback_query) return callback(u.callback_query, env);
  const m = u.message;
  if (!m || !m.text) return;
  const bot = await me(env);
  const text = m.text.trim();
  const priv = m.chat.type === 'private';
  const name = (bot.username || '').toLowerCase();
  const mentioned = name && (text.toLowerCase().includes(`@${name}`) || (m.entities ?? []).some((e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${name}`));
  const command = /^\/(start|mukhwak|video|help)(@\w+)?\b/i.exec(text);
  if (command && command[2] && command[2].slice(1).toLowerCase() !== name) return;   // another bot's command
  const repliedToBot = m.reply_to_message?.from?.id === bot.id;
  if (!priv && !mentioned && !command && !repliedToBot) return;
  if (command && (command[1].toLowerCase() === 'help' || /^\/start\s+custom/i.test(text))) return send(env, m, helpText(bot.username));
  const ask = parse(text.replace(new RegExp(`@${name}`, 'ig'), '').replace(/^\/\w+(@\w+)?/, ''));
  const ix = await today(env);
  if (!ix) return send(env, m, '⏳ ਅੱਜ ਦੀਆਂ ਵੀਡੀਓ ਹਾਲੇ ਨਹੀਂ ਬਣੀਆਂ · Today’s videos aren’t ready yet — try again a little later.');
  // A custom length or speed → made to order.
  if (ask.speed || ask.seconds) {
    const p = ask.preset ? PRESETS[ask.preset] : null;
    const fmt = ask.fmt || p?.fmt || 'story';
    const seconds = ask.seconds || (p && !p.whole ? p.sec : 0);
    const speed = ask.speed || (seconds ? CHOP_SPEED : 1);
    return toOrder(env, m, { lang: ask.lang || 'pa', fmt, seconds, speed, res: ask.res || 1080, label: p?.label || '' });
  }
  if (ask.preset) return deliver(env, m.chat.id, m.message_id, ix, ask.lang || 'pa', ask.res || 1080, ask.preset);
  return menu(env, m, ix, ask.lang || 'pa', ask.res || 1080);
}

/** Words → what is asked: "reel 1.25x 2:00 16:9 720p en". */
export function parse(t) {
  let s = ` ${t.toLowerCase().replace(/,/g, '.')} `;
  const out = {};
  const sp = s.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*[x×](?=\s|$)/) || s.match(/(?:^|\s)[x×]\s*(\d+(?:\.\d+)?)(?=\s|$)/) || s.match(/speed\s*(\d+(?:\.\d+)?)/);
  // (Taken out of the text, so "x 1.5" isn't read as X / Twitter.)
  if (sp) { out.speed = Math.min(3, Math.max(0.5, Number(sp[1]))); s = s.replace(sp[0], ' '); }
  const mmss = s.match(/(?:^|\s)(\d{1,2}):([0-5]\d)(?=\s|$)/);
  const secs = s.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|ਸਕਿੰਟ)(?=\s|$)/);
  const mins = s.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|ਮਿੰਟ)(?=\s|$)/);
  if (mmss) out.seconds = Number(mmss[1]) * 60 + Number(mmss[2]);
  else if (secs) out.seconds = Number(secs[1]);
  else if (mins) out.seconds = Number(mins[1]) * 60;
  if (out.seconds) out.seconds = Math.min(1200, Math.max(5, Math.round(out.seconds)));
  if (/(?:^|\s)(16:9|wide|landscape|horizontal)(?=\s|$)/.test(s)) out.fmt = 'wide';
  else if (/(?:^|\s)(4:5|square|feed|post)(?=\s|$)/.test(s)) out.fmt = 'post';
  else if (/(?:^|\s)(9:16|vertical|tall|portrait)(?=\s|$)/.test(s)) out.fmt = 'story';
  const res = s.match(/(?:^|\s)(1080|720|480)\s*p?(?=\s|$)/);
  if (res) out.res = Number(res[1]);
  if (/(?:^|\s)(en|eng|english)(?=\s|$)/.test(s)) out.lang = 'en';
  else if (/(?:^|\s)(hi|hindi|हिंदी|हिन्दी)(?=\s|$)/.test(s)) out.lang = 'hi';
  else if (/(?:^|\s)(pnb|shahmukhi|urdu|شاہمکھی)(?=\s|$)/.test(s)) out.lang = 'pnb';
  else if (/(?:^|\s)(pa|pun|punjabi|gurmukhi|ਪੰਜਾਬੀ)(?=\s|$)/.test(s)) out.lang = 'pa';
  const has = (re) => re.test(s);
  const insta = has(/insta|instagram|\big\b/), fb = has(/facebook|\bfb\b/), yt = has(/youtube|\byt\b/);
  if (has(/story|stories/)) out.preset = fb ? 'fbs' : 'igs';
  else if (has(/\breels?\b/)) out.preset = fb ? 'fbr' : 'igr';
  else if (has(/\bshorts?\b/)) out.preset = 'yts';
  else if (yt) out.preset = 'ytw';
  else if (has(/tiktok|tik tok/)) out.preset = 'tt';
  else if (has(/whatsapp|status|\bwa\b/)) out.preset = 'wa';
  else if (has(/twitter|(?:^|\s)x(?=\s|$)/)) out.preset = 'x';
  else if (has(/feed|post/)) out.preset = fb && out.fmt === 'wide' ? 'fbw' : 'feed';
  else if (fb) out.preset = out.fmt === 'wide' ? 'fbw' : 'fbr';
  else if (insta) out.preset = 'igr';
  else if (has(/full|whole|ਪੂਰਾ/)) out.preset = 'full';
  return out;
}

function helpText(user) {
  const at = user ? `@${user}` : '@bot';
  return [
    '🙏 ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ, ਹਰ ਥਾਂ ਲਈ ਵੀਡੀਓ · Today’s MukhWak, a video for every place:',
    `• ${at} — ਮੀਨੂ · the menu (Insta, Facebook, YouTube, TikTok, WhatsApp, X…)`,
    `• ${at} reel · ${at} story en · ${at} youtube 720p`,
    `• ${at} 1.25x 2:00 16:9 — ਆਪਣੀ ਲੰਬਾਈ / ਰਫ਼ਤਾਰ · your own length / speed (made in about a minute)`,
    `• ਕਿਸੇ ਵੀ ਚੈਟ ਵਿੱਚ “${at} ” ਲਿਖੋ · type “${at} ” in any chat to send one there`,
    'ਛੋਟੀਆਂ (ਕੱਟੀਆਂ) ਵੀਡੀਓ ×1.6 · cut videos are ×1.6 unless you ask for another speed.',
  ].join('\n');
}

function send(env, m, text, extra = {}) {
  return api(env, 'sendMessage', { chat_id: m.chat.id, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true }, ...extra });
}

/* ── The menu ────────────────────────────────────────────────────────── */

function keyboard(ix, lang, res) {
  const rows = [];
  rows.push(LANGS.filter(([c]) => ix?.langs?.[c]).map(([c, l]) => ({ text: `${c === lang ? '✓ ' : ''}${l}`, callback_data: `m|${c}|${res}` })));
  rows.push(RESES.map((r) => ({ text: `${r === res ? '✓ ' : ''}${r}p`, callback_data: `m|${lang}|${r}` })));
  for (let i = 0; i < ORDER.length; i += 2) {
    rows.push(ORDER.slice(i, i + 2).map((k) => {
      const p = PRESETS[k];
      const v = ready(ix, lang, p);
      const len = v ? `${Math.floor(v.seconds / 60)}:${String(v.seconds % 60).padStart(2, '0')}` : p.sec ? `${p.sec}s` : '';
      return { text: `${p.label}${len ? ` · ${len}` : ''}`, callback_data: `v|${lang}|${res}|${k}` };
    }));
  }
  return { inline_keyboard: rows };
}

function menuText(ix, user) {
  return `🙏 ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ · ${ix.date} · ਅੰਗ ${ix.ang}\nਕਿੱਥੇ ਪਾਉਣੀ ਹੈ? Where is it going?\n` +
    `ਆਪਣੀ ਲੰਬਾਈ / ਰਫ਼ਤਾਰ · your own: ${user ? `@${user} ` : ''}1.25x 2:00 16:9 720p`;
}

async function menu(env, m, ix, lang, res) {
  const bot = await me(env);
  return send(env, m, menuText(ix, bot.username), { reply_markup: keyboard(ix, lang, res) });
}

async function callback(q, env) {
  const [kind, lang, resS, key] = String(q.data || '').split('|');
  const res = Number(resS) || 1080;
  const ix = await today(env);
  if (!ix) return api(env, 'answerCallbackQuery', { callback_query_id: q.id, text: '⏳ not ready yet', show_alert: false });
  if (kind === 'm') {
    await api(env, 'answerCallbackQuery', { callback_query_id: q.id });
    return api(env, 'editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: keyboard(ix, lang, res) });
  }
  if (kind === 'v' && PRESETS[key]) {
    if (await tooSoon(env, `u${q.from.id}`, 4)) return api(env, 'answerCallbackQuery', { callback_query_id: q.id, text: '⏳ …' });
    await api(env, 'answerCallbackQuery', { callback_query_id: q.id, text: `⏳ ${PRESETS[key].label}` });
    return deliver(env, q.message.chat.id, q.message.message_id, ix, lang, res, key);
  }
  return api(env, 'answerCallbackQuery', { callback_query_id: q.id });
}

/* ── Sending ─────────────────────────────────────────────────────────── */

async function deliver(env, chat, replyTo, ix, lang, res, key) {
  const p = PRESETS[key];
  const v = ready(ix, lang, p);
  if (!v || res !== 1080) {
    // Not ready-made in this shape / size: made to order (the robot's lengths and speed).
    const seconds = p.whole ? 0 : p.sec;
    return toOrder(env, { chat: { id: chat }, message_id: replyTo }, { lang, fmt: p.fmt, seconds, speed: seconds ? (v?.speed || CHOP_SPEED) : (p.key === 'fit' && v?.speed) || 1, res, label: p.label });
  }
  const caption = `ਮੁੱਖਵਾਕ ${ix.date} · ${p.label} · ${SHAPE[p.fmt]} · ${Math.floor(v.seconds / 60)}:${String(v.seconds % 60).padStart(2, '0')}${v.speed ? ` · ×${v.speed}` : ''}\nsevalekh.com`;
  const [w, h] = p.fmt === 'wide' ? [1920, 1080] : p.fmt === 'post' ? [1080, 1350] : [1080, 1920];
  const base = { chat_id: chat, caption, width: w, height: h, duration: v.seconds, supports_streaming: true, reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
  const ck = `f:${ix.made || ix.date}:${v.file}`;
  const cached = env.CACHE ? await env.CACHE.get(ck) : null;
  let r;
  if (cached) r = await api(env, 'sendVideo', { ...base, video: cached });
  // Telegram fetches files up to 20 MB from an address itself; bigger ones are uploaded.
  if (!r?.ok && v.bytes < 19.5e6) r = await api(env, 'sendVideo', { ...base, video: fileUrl(env, v.file) });
  if (!r?.ok) {
    const f = new FormData();
    for (const [k, val] of Object.entries(base)) f.append(k, typeof val === 'object' ? JSON.stringify(val) : String(val));
    const blob = await (await fetch(fileUrl(env, v.file))).blob();
    f.append('video', new File([blob], v.file.split('/').pop(), { type: 'video/mp4' }));
    r = await api(env, 'sendVideo', f);
  }
  const id = r?.result?.video?.file_id;
  if (id && env.CACHE) await env.CACHE.put(ck, id, { expirationTtl: 3 * 86400 });
  if (!r?.ok) await api(env, 'sendMessage', { chat_id: chat, text: `⚠ ${r?.description || 'not sent'} — ${fileUrl(env, v.file)}` });
}

/** Made to order by the GitHub Action (telegram-video.yml), sent back to the chat when done. */
async function toOrder(env, m, o) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    return send(env, m, '🙏 ਇਹ ਵੀਡੀਓ ਤਿਆਰ ਨਹੀਂ · That one isn’t ready-made — pick one from the menu (the bot’s keeper can switch on videos made to order: GH_TOKEN).');
  }
  if (await tooSoon(env, `c${m.chat.id}`, 45)) return send(env, m, '⏳ ਇੱਕ ਵੀਡੀਓ ਬਣ ਰਹੀ ਹੈ — ਥੋੜ੍ਹਾ ਰੁਕੋ · One is being made — please wait a minute.');
  const inputs = {
    chat: String(m.chat.id), reply: String(m.message_id || ''), lang: o.lang, fmt: o.fmt,
    seconds: o.seconds ? String(o.seconds) : '', speed: String(o.speed), res: String(o.res), label: o.label || '',
  };
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/telegram-video.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'sevalekh-bot', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: env.GH_REF || 'main', inputs }),
  });
  if (!r.ok) return send(env, m, `⚠ ${r.status} — couldn’t start making it.`);
  const len = o.seconds ? `${Math.floor(o.seconds / 60)}:${String(o.seconds % 60).padStart(2, '0')}` : 'ਪੂਰਾ · whole';
  return send(env, m, `⏳ ਬਣ ਰਹੀ ਹੈ (ਲਗਭਗ 1 ਮਿੰਟ) · Making it (about a minute): ${o.label ? `${o.label} · ` : ''}${SHAPE[o.fmt]} · ${len} · ×${o.speed} · ${o.res}p`);
}

/** At most one request per `sec` seconds per key (when the CACHE namespace is bound). */
async function tooSoon(env, key, sec) {
  if (!env.CACHE) return false;
  const k = `rl:${key}`;
  if (await env.CACHE.get(k)) return true;
  await env.CACHE.put(k, '1', { expirationTtl: Math.max(60, sec) });
  return false;
}

/* ── Inline mode: "@bot " in any chat ───────────────────────────────── */

async function inline(q, env) {
  const ask = parse(q.query || '');
  const lang = ask.lang || 'pa';
  const ix = await today(env);
  const results = [];
  if (ix) {
    const keys = ask.preset ? [ask.preset, ...ORDER.filter((k) => k !== ask.preset)] : ORDER;
    const seen = new Set();
    for (const k of keys) {
      const p = PRESETS[k];
      const v = ready(ix, lang, p);
      if (!v || seen.has(v.file)) continue;
      seen.add(v.file);
      const thumb = ix.langs[lang]?.thumb || ix.langs[lang]?.preview || ix.langs[lang]?.story?.images?.[0];
      const len = `${Math.floor(v.seconds / 60)}:${String(v.seconds % 60).padStart(2, '0')}`;
      const caption = `ਮੁੱਖਵਾਕ ${ix.date} · ${p.label} · ${SHAPE[p.fmt]} · ${len}${v.speed ? ` · ×${v.speed}` : ''}\nsevalekh.com`;
      const cached = env.CACHE ? await env.CACHE.get(`f:${ix.made || ix.date}:${v.file}`) : null;
      results.push(cached
        ? { type: 'video', id: k, video_file_id: cached, title: `${p.label} · ${len}`, description: `${SHAPE[p.fmt]}${v.speed ? ` · ×${v.speed}` : ''} · ${ix.date}`, caption }
        : { type: 'video', id: k, video_url: fileUrl(env, v.file), mime_type: 'video/mp4', thumbnail_url: thumb ? fileUrl(env, thumb) : undefined,
            title: `${p.label} · ${len}`, description: `${SHAPE[p.fmt]}${v.speed ? ` · ×${v.speed}` : ''} · ${ix.date}`, caption });
    }
  }
  return api(env, 'answerInlineQuery', {
    inline_query_id: q.id, results, cache_time: 300, is_personal: false,
    // Opens a private chat with the bot: the menu, and videos of any length / speed.
    button: results.length
      ? { text: '⚙ ਆਪਣੀ ਲੰਬਾਈ / ਰਫ਼ਤਾਰ · your own length / speed', start_parameter: 'custom' }
      : { text: '⏳ ਹਾਲੇ ਤਿਆਰ ਨਹੀਂ · not ready yet — open the bot', start_parameter: 'menu' },
  });
}
