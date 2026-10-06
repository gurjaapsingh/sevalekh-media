/**
 * 📣 After the day's files are live on GitHub Pages: post the MukhWak video to
 * Instagram (Reel) and YouTube (Short). Each is optional — it runs only when
 * its secrets are set (see SETUP-YOUTUBE-INSTAGRAM.md). Failures are warnings:
 * one platform failing never stops the other, nor the published files.
 *
 * Env:
 *   PAGES_URL      where the robot publishes (https://<owner>.github.io/sevalekh-media)
 *   MADE           the build's timestamp — wait until Pages serves that build
 *   SOCIAL_LANG    language of the posts (default pa)
 *   Instagram:  IG_ACCESS_TOKEN (secret), IG_USER_ID (optional), IG_API_HOST
 *               (graph.instagram.com — Instagram Login; or graph.facebook.com),
 *               IG_VIDEO (reel: 90 s — Instagram's API limit for Reels)
 *   YouTube:    YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN (secrets),
 *               YT_VIDEO (fit: whole MukhWak in 2:59 — a Short; else full),
 *               YT_PRIVACY (public; Google keeps uploads private until its audit)
 */
const PAGES = (process.env.PAGES_URL || '').replace(/\/+$/, '');
const MADE = process.env.MADE || '';
const LANG = (process.env.SOCIAL_LANG || 'pa').trim();
const log = (...a) => console.log(...a);
const warn = (m) => console.warn(`::warning::${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '');

// ── Today's index, as Pages serves it (the CDN can lag the deploy a little) ──
async function latest() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${PAGES}/mukhwak/latest.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const ix = await r.json();
        if (!MADE || ix.made === MADE) return ix;
      }
    } catch { /* not yet */ }
    await sleep(15_000);
  }
  throw new Error('GitHub Pages is not serving this build yet');
}

const ix = await latest();
const e = ix.langs?.[LANG];
if (!e) { warn(`Social: no media in "${LANG}" today`); process.exit(0); }
const pick = (keys) => keys.map((k) => e.story?.videos?.[k] && { key: k, ...e.story.videos[k] }).find(Boolean);
const fileUrl = (f) => `${PAGES}/mukhwak/${f}?v=${encodeURIComponent(ix.made)}`;
const caption = (e.caption || '').trim();

// ── Instagram Reel ──
async function instagram() {
  const token = clean(process.env.IG_ACCESS_TOKEN);
  if (!token) return log('Instagram: not set up (IG_ACCESS_TOKEN) — skipped.');
  const host = (process.env.IG_API_HOST || 'graph.instagram.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const api = async (method, pathname, params = {}) => {
    const u = new URL(`https://${host}/v23.0/${pathname}`);
    const body = new URLSearchParams({ ...params, access_token: token });
    const r = method === 'GET'
      ? await fetch(`${u}?${body}`)
      : await fetch(u, { method, body });
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      const m = j.error.message || `HTTP ${r.status}`;
      const hint = /expired|session/i.test(m) ? ' — the Instagram token expired: make a new one (SETUP-YOUTUBE-INSTAGRAM.md, Instagram step 5) and update the IG_ACCESS_TOKEN secret'
        : /permission|scope/i.test(m) ? ' — the token lacks instagram_business_content_publish (or the account isn’t a Business/Creator account)' : '';
      throw new Error(`${pathname}: ${m}${hint}`);
    }
    return j;
  };
  // Long-lived Instagram-Login tokens last 60 days; refreshing keeps them going.
  if (host === 'graph.instagram.com') {
    try {
      const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`).then((x) => x.json());
      if (r.expires_in) {
        const days = Math.round(r.expires_in / 86400);
        log(`Instagram: token good for ${days} more days`);
        if (days < 10) warn(`Instagram: the token runs out in ${days} days — make a new one and update IG_ACCESS_TOKEN`);
      }
    } catch { /* not fatal */ }
  }
  const user = clean(process.env.IG_USER_ID) || (await api('GET', 'me', { fields: 'user_id,username' })).user_id;
  const v = pick([process.env.IG_VIDEO || 'reel', 'reel', 'short']);
  if (!v) throw new Error('no 90-s reel video today');
  if (v.seconds > 90) throw new Error(`the "${v.key}" video is ${v.seconds} s — Instagram's API takes Reels up to 90 s`);
  const c = await api('POST', `${user}/media`, {
    media_type: 'REELS', video_url: fileUrl(v.file), caption: caption.slice(0, 2200), share_to_feed: 'true',
  });
  // Instagram fetches and processes the video: usually under a minute.
  for (let i = 0; i < 40; i++) {
    await sleep(10_000);
    const s = await api('GET', c.id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') {
      const p = await api('POST', `${user}/media_publish`, { creation_id: c.id });
      return log(`Instagram: posted the ${v.key} video (${v.seconds} s) as a Reel — media ${p.id}`);
    }
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram couldn't process the video: ${s.status || s.status_code}`);
  }
  throw new Error('Instagram was still processing the video after 7 minutes');
}

// ── YouTube Short ──
async function youtube() {
  const id = clean(process.env.YT_CLIENT_ID), secret = clean(process.env.YT_CLIENT_SECRET), refresh = clean(process.env.YT_REFRESH_TOKEN);
  if (!id || !secret || !refresh) return log('YouTube: not set up (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN) — skipped.');
  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  }).then((r) => r.json());
  if (!tok.access_token) {
    throw new Error(`Google didn't accept the YouTube sign-in (${tok.error_description || tok.error || 'no answer'})${tok.error === 'invalid_grant'
      ? ' — the refresh token expired or was revoked. If the Google Cloud app is still in "Testing", tokens last only 7 days: set it to "In production" and make a new token (SETUP-YOUTUBE-INSTAGRAM.md, YouTube step 6)' : ''}`);
  }
  const v = pick([process.env.YT_VIDEO || 'fit', 'fit', 'full']);
  if (!v) throw new Error('no video today');
  const bytes = Buffer.from(await (await fetch(fileUrl(v.file))).arrayBuffer());
  const [yy, mm, dd] = String(ix.date || '').split('-');   // "2026-10-04"
  const dateText = dd ? `${Number(dd)}-${Number(mm)}-${yy}` : '';
  const title = `ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ ${dateText} · ਸ੍ਰੀ ਦਰਬਾਰ ਸਾਹਿਬ, ਅੰਮ੍ਰਿਤਸਰ · MukhWak${v.seconds <= 180 ? ' #Shorts' : ''}`.slice(0, 100);
  const description = `${caption}\n\n📖 ਅਰਥਾਂ ਸਮੇਤ ਪੜ੍ਹੋ · Read with meanings: https://sevalekh.com/#/mukhwak\n🎵 ਆਡੀਓ: SGPC, ਸ੍ਰੀ ਦਰਬਾਰ ਸਾਹਿਬ`.slice(0, 4900);
  const meta = {
    snippet: { title, description, categoryId: process.env.YT_CATEGORY || '22', defaultLanguage: 'pa', defaultAudioLanguage: 'pa', tags: ['MukhWak', 'Hukamnama', 'Gurbani', 'SevaLekh'] },
    status: { privacyStatus: process.env.YT_PRIVACY || 'public', selfDeclaredMadeForKids: false },
  };
  const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(bytes.length),
    },
    body: JSON.stringify(meta),
  });
  const where = start.headers.get('location');
  if (!where) throw new Error(`YouTube refused the upload: ${(await start.text()).slice(0, 300)}`);
  const up = await fetch(where, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes });
  const j = await up.json().catch(() => ({}));
  if (!j.id) throw new Error(`YouTube upload failed: ${JSON.stringify(j.error || j).slice(0, 300)}`);
  log(`YouTube: uploaded the ${v.key} video (${v.seconds} s) — https://youtu.be/${j.id} (${j.status?.privacyStatus})`);
  if (j.status?.privacyStatus === 'private' && meta.status.privacyStatus !== 'private') {
    warn('YouTube: the video is private — Google keeps uploads from unaudited apps private until its (free) API audit passes. See SETUP-YOUTUBE-INSTAGRAM.md, YouTube step 7.');
  }
}

for (const [name, fn] of [['Instagram', instagram], ['YouTube', youtube]]) {
  try { await fn(); } catch (err) { warn(`${name}: ${err.message}`); }
}
