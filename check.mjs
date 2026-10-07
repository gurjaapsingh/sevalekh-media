/**
 * Quick check before the (slow) robot run: is there anything to make?
 *
 * Runs every 15 minutes through India's morning with no installs, in a few
 * seconds. Says "go" only when today's (India time) MukhWak isn't published
 * yet AND today's text (BaniDB, or SGPC's page while BaniDB lags) and SGPC's audio are up — so early
 * runs simply wait, instead of failing in red.
 *
 * Env: PAGES_URL, FORCE=1 (manual "force" run: always go).
 */
import fs from 'node:fs/promises';
import { meaningsFingerprint, mukhwakAngs } from './fingerprint.mjs';

const PAGES = (process.env.PAGES_URL || '').replace(/\/+$/, '');
const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const say = (m) => console.log('•', m);

const ist = new Date(Date.now() + 5.5 * 3600_000);
const y = ist.getUTCFullYear(), m = ist.getUTCMonth() + 1, d = ist.getUTCDate();
const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
say(`India date ${today}, ${ist.toISOString().slice(11, 16)} India time`);

if (process.env.FORCE) { say('Forced run: making them now.'); await out('go', 'true'); await out('reason', 'forced'); process.exit(0); }

const get = async (url, opts = {}) => {
  try { return await fetch(url, { signal: AbortSignal.timeout(20_000), ...opts }); } catch { return null; }
};

// 1. Already published today?
const pub = await get(`${PAGES}/mukhwak/latest.json`, { cache: 'no-store' });
if (pub?.ok) {
  const j = await pub.json().catch(() => ({}));
  if (j.date === today) {
    // Already made today — but if meanings of today's MukhWak were edited or
    // approved since, make them again so the pictures and videos show the latest.
    const now = await meaningsFingerprint(await mukhwakAngs(y, m, d));
    if (now && j.fingerprint && now !== j.fingerprint) {
      say(`Meanings changed since this morning's videos (made ${j.made}) — making them again.`);
      await out('go', 'true'); await out('reason', 'edited'); process.exit(0);
    }
    say(`Today's are already published (made ${j.made}), meanings unchanged. Nothing to do.`);
    await out('go', 'false'); process.exit(0);
  }
  say(`Published now: ${j.date ?? 'nothing'}.`);
}

// 2. BaniDB has today's MukhWak?
const b = await get(`https://api.banidb.com/v2/hukamnamas/${y}/${m}/${d}`);
const bj = b?.ok ? await b.json().catch(() => null) : null;
if (!bj?.shabads?.length) {
  // BaniDB can lag SGPC by hours: read today's from SGPC's own page instead (sgpc.mjs).
  const { sgpcMukhwak } = await import('./sgpc.mjs');
  const s = await sgpcMukhwak(today).catch((e) => ({ error: e.message }));
  if (s.error) { say(`BaniDB doesn't have ${today}'s MukhWak yet, nor SGPC's page (${s.error}) — waiting for the next check.`); await out('go', 'false'); process.exit(0); }
  say(`BaniDB doesn't have ${today}'s MukhWak yet — SGPC's page does (Ang ${s.sgpc.ang}, shabads ${s.shabadIds.join(', ')}).`);
}

// 3. SGPC's recording for today is up?
const two = (n) => String(n % 100).padStart(2, '0');
const audio = `https://hs.sgpc.net/hukamnamaaudio/SGPCNET${two(d)}${two(m)}${two(y)}.mp3`;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const a = await get(audio, { headers: { ...UA, Range: 'bytes=0-1023' } });
if (!a || !(a.ok || a.status === 206)) {
  // Blocked or not up: let the robot try anyway if a relay is set (it knows how), else wait.
  if (process.env.AUDIO_RELAY) say(`SGPC audio answered ${a?.status ?? 'nothing'} — trying with the relay.`);
  else { say(`SGPC's audio for ${today} isn't up yet (${a?.status ?? 'no answer'}) — waiting for the next check.`); await out('go', 'false'); process.exit(0); }
}

say('Text and audio are up: making today\'s pictures and videos.');
await out('go', 'true');
await out('reason', 'new');
