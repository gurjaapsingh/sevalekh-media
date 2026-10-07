/**
 * Today's MukhWak straight from SGPC (hs.sgpc.net), for the hours when SGPC has
 * it up but BaniDB's /hukamnamas hasn't caught up yet (Oct 7, 2026: SGPC by
 * ~05:30 India, BaniDB still on Oct 6 at 06:15).
 *
 * SGPC's page gives the date, the Ang and the Gurbani as text. The lines are
 * found among BaniDB's verses on that Ang and the next two (word for word,
 * spaces and ॥ markers ignored), which gives the Shabad ids and exactly which
 * of their verses were read (a Vaar's Saloks + Pauri are a part of one BaniDB
 * Shabad). The result has BaniDB's own /hukamnamas shape, so SevaLekh's page
 * can be handed it as if BaniDB had answered.
 *
 *   node sgpc.mjs            → prints what it finds for today (India date)
 */
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const get = async (url, opts = {}) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000), ...opts });
      if (r.ok) return r;
      if (r.status === 404) return null;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  return null;
};
const gDigit = (s) => Number(String(s).replace(/[੦-੯]/g, (c) => String('੦੧੨੩੪੫੬੭੮੯'.indexOf(c))));
/** Letters only: no spaces, ॥ ।, numerals or punctuation; one Unicode form. */
const norm = (s) => String(s ?? '').normalize('NFC').replace(/[\s॥।੦-੯0-9.,;:!?'"‘’“”()\-–—]/g, '')
  // Vowel signs typed in a different order (ਭੁੋ / ਭੋੁ) are the same letter.
  .replace(/[\u0A01-\u0A03\u0A3C-\u0A4D\u0A70\u0A71\u0A75]+/g, (m) => [...m].sort().join(''));

/** SGPC's page → { date: 'YYYY-MM-DD', ang, gurbani } (null if it can't be read). */
export async function readSgpc() {
  const r = await get('https://hs.sgpc.net/index.php', { headers: UA });
  if (!r) return null;
  const html = await r.text();
  const t = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const dm = t.match(/(\d{2})-(\d{2})-(\d{4})/);
  const am = t.match(/\(\s*Ang:?\s*(\d{1,4})\s*\)/i) ?? t.normalize('NFC').match(/ਅੰਗ:?\s*([੦-੯]{1,4})/);
  if (!dm || !am) return null;
  const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const ang = gDigit(am[1]);
  // The Gurbani: after the audio links (or the date), up to the last ॥ before the Nanakshahi date.
  const n = t.normalize('NFC');
  const k = n.lastIndexOf('Katha Audio');
  const from = k > 0 ? k + 'Katha Audio'.length : n.indexOf(dm[0]) + dm[0].length;
  const sam = n.indexOf('(ਸੰਮਤ', from);
  let block = n.slice(from, sam > 0 ? sam : undefined).replace(/https?:\S+/g, ' ');
  block = block.slice(0, block.lastIndexOf('॥') + 1);
  return { date, ang, gurbani: block.trim() };
}

async function angVerses(n) {
  const r = await get(`https://api.banidb.com/v2/angs/${n}/G`);
  const j = r ? await r.json().catch(() => null) : null;
  return (j?.page ?? j?.verses ?? []).map((v) => ({ verseId: Number(v.verseId), shabadId: Number(v.shabadId), unicode: String(v.verse?.unicode ?? '') }));
}

/**
 * Today's MukhWak from SGPC in BaniDB's /hukamnamas shape, or null.
 * `today`: 'YYYY-MM-DD' (India date) — SGPC's page must show that date.
 */
export async function sgpcMukhwak(today) {
  const s = await readSgpc();
  if (!s) return { error: 'SGPC page could not be read' };
  if (s.date !== today) return { error: `SGPC shows ${s.date}, not ${today}` };
  const G = norm(s.gurbani);
  if (G.length < 20) return { error: 'No Gurbani found on SGPC page' };
  const verses = [...(await angVerses(s.ang)), ...(await angVerses(s.ang + 1)), ...(await angVerses(s.ang + 2))];
  // Each verse found in SGPC's text (in order); short ones (ਮਃ ੩ ॥) are kept later by range.
  const found = [];
  let pos = 0;
  let covered = 0;
  for (const v of verses) {
    const nv = norm(v.unicode);
    if (nv.length < 6) continue;
    const at = G.indexOf(nv, Math.max(0, pos - 2));
    if (at < 0) continue;
    found.push({ ...v, at });
    pos = at + nv.length;
    covered += nv.length;
  }
  if (!found.length || covered / G.length < 0.6) return { error: `Only ${Math.round((covered / G.length) * 100)}% of SGPC's text found on Ang ${s.ang}–${s.ang + 2}` };
  // Shabads in reading order, each trimmed to the verses from its first found line to its last.
  const ids = [...new Set(found.map((f) => f.shabadId))];
  const shabads = [];
  for (const id of ids) {
    const r = await get(`https://api.banidb.com/v2/shabads/${id}`);
    const j = r ? await r.json().catch(() => null) : null;
    if (!j?.verses?.length) return { error: `BaniDB shabad ${id} unavailable` };
    const mine = found.filter((f) => f.shabadId === id).map((f) => f.verseId);
    const idx = j.verses.map((v) => Number(v.verseId));
    let a = Math.min(...mine.map((v) => idx.indexOf(v)));
    const b = Math.max(...mine.map((v) => idx.indexOf(v)));
    // Headings just before the first line (ਸਲੋਕ ਮਃ ੩ ॥, ੴ …) when SGPC has them too.
    while (a > 0 && G.includes(norm(j.verses[a - 1].verse?.unicode)) && norm(j.verses[a - 1].verse?.unicode).length < 30) a--;
    shabads.push({ shabadInfo: j.shabadInfo, verses: j.verses.slice(a, b + 1) });
  }
  const [y, m, d] = today.split('-').map(Number);
  return {
    date: { gregorian: { year: y, month: m, date: d } },
    shabadIds: ids,
    shabads,
    sgpc: { ang: s.ang, verseIds: shabads.flatMap((x) => x.verses.map((v) => Number(v.verseId))) },
  };
}

// CLI: node sgpc.mjs
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sgpc.mjs')) {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const today = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
  const r = await sgpcMukhwak(today);
  if (r.error) console.log('✗', r.error);
  else console.log('✓', today, 'shabads', r.shabadIds.join(','), '· verses', r.sgpc.verseIds.length, '·', r.shabads.map((s) => s.verses.map((v) => v.verse.unicode).join(' / ')).join('\n  '));
}
