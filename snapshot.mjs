/**
 * 📚 A daily copy of SevaLekh's PUBLISHED work for visitors.
 *
 * SevaLekh runs on Firebase's free plan: 50,000 database reads a day. The
 * public view and the public dictionary used to read EVERY approved entry on
 * every visit (one read per entry), which used the day's reads up. The robot
 * now reads them once, here, and publishes two files next to the MukhWak media:
 *
 *   data/approved.json     — approved meanings (verse vyakhya and Shabad prasang)
 *   data/definitions.json  — approved Shabadkosh definitions
 *
 * Visitors load these instead (GitHub Pages, free), and still read the one Ang
 * they open live from the database, so what they read is always current.
 *
 * Reads Firestore's public REST API with no key — only what any visitor may
 * read (status == approved). Volunteers' account ids and edit history are left
 * out; only what the public pages show is kept.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT = process.env.FIREBASE_PROJECT || 'sttmpure';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PAGE = 500;

/** Firestore REST value → plain JSON. */
function val(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return fields(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(val);
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
const fields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));

/** Every approved document of a collection, 500 at a time. */
async function approved(collectionId) {
  const out = [];
  let last = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'approved' } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: PAGE,
      ...(last ? { startAt: { values: [{ referenceValue: last }], before: false } } : {}),
    };
    const r = await fetch(`${BASE}:runQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }), signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`${collectionId}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = (await r.json()).filter((x) => x.document);
    for (const x of rows) out.push({ id: x.document.name.split('/').pop(), ...fields(x.document.fields) });
    if (rows.length < PAGE) break;
    last = rows[rows.length - 1].document.name;
  }
  return out;
}

/** Only what the public pages show: no account ids, no edit history. */
const PRIVATE = ['history', 'createdBy', 'lastEditedBy', 'createdByName', 'lastEditedByName', 'flagged', 'commentCount'];
function publicOnly(d) {
  const o = { ...d };
  for (const k of PRIVATE) delete o[k];
  if (o.transMeta && typeof o.transMeta === 'object') {
    o.transMeta = Object.fromEntries(Object.entries(o.transMeta).map(([lang, m]) => {
      const { by, byName, ...rest } = m ?? {};
      return [lang, rest];
    }));
  }
  return o;
}

/** Writes OUT/data/*.json. Never throws: the visitors' pages fall back to the database. */
export async function writeSnapshot(outDir, log = console.log) {
  const dir = path.join(outDir, 'data');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, coll] of [['approved', 'interpretations'], ['definitions', 'definitions']]) {
    try {
      const items = (await approved(coll)).map(publicOnly);
      const at = Date.now();
      await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({ at, count: items.length, items }));
      log(`Snapshot: ${items.length} approved ${coll} → data/${name}.json`);
    } catch (e) {
      console.warn(`::warning::Snapshot of ${coll} failed (${e.message}) — visitors read the database directly until the next run.`);
    }
  }
}

// Run on its own: node snapshot.mjs [outDir]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('snapshot.mjs')) {
  await writeSnapshot(path.resolve(process.argv[2] || 'site'));
}
