/**
 * A fingerprint of today's approved SevaLekh meanings: if anyone edits or
 * approves meanings of today's MukhWak after the morning's videos were made,
 * the fingerprint changes and the robot makes them again.
 *
 * Reads Firestore's public REST API with no key — the same approved entries
 * any visitor can read (firestore.rules allows that while public mode is on).
 */
import { createHash } from 'node:crypto';

const PROJECT = process.env.FIREBASE_PROJECT || 'sttmpure';
const RUN_QUERY = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`;

/** The Angs today's MukhWak spans (a Shabad can run onto the next Ang). */
export async function mukhwakAngs(y, m, d) {
  const r = await fetch(`https://api.banidb.com/v2/hukamnamas/${y}/${m}/${d}`, { signal: AbortSignal.timeout(20_000) });
  const j = r.ok ? await r.json() : null;
  const angs = new Set();
  for (const s of j?.shabads ?? []) {
    if (s?.shabadInfo?.pageNo) angs.add(s.shabadInfo.pageNo);
    for (const v of s?.verses ?? []) if (v?.pageNo) angs.add(v.pageNo);
  }
  return [...angs].sort((a, b) => a - b);
}

/** Hash of every approved entry on those Angs and when it last changed; null if it can't be read. */
export async function meaningsFingerprint(angs) {
  if (!angs?.length) return null;
  const parts = [];
  try {
    for (const ang of angs) {
      const body = {
        structuredQuery: {
          from: [{ collectionId: 'interpretations' }],
          where: { compositeFilter: { op: 'AND', filters: [
            { fieldFilter: { field: { fieldPath: 'ang' }, op: 'EQUAL', value: { integerValue: String(ang) } } },
            { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'approved' } } },
          ] } },
          select: { fields: [{ fieldPath: 'currentVersion' }] },
        },
      };
      const r = await fetch(RUN_QUERY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return null;
      for (const row of await r.json()) {
        if (row.document) parts.push(`${row.document.name.split('/').pop()}@${row.document.updateTime}`);
      }
    }
  } catch { return null; }
  return createHash('sha1').update(parts.sort().join('\n')).digest('hex').slice(0, 16);
}
