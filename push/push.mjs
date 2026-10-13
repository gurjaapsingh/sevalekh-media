/**
 * 🔔 SevaLekh notifications — run every 15 minutes by .github/workflows/push.yml.
 *
 * The app only stores each device's token and choices (pushTokens/{token},
 * src/push.ts). This robot does the rest with Firebase Cloud Messaging, which
 * is free and needs no Cloud Functions, so SevaLekh stays on the Spark plan.
 *
 * News for everyone goes out by topic, one per kind × language × time zone ×
 * "when" (sl_vyakhya_pa_Asia.Kolkata_day …). Each device chooses when it is
 * told: ☀ daytime (default, DAY_START–DAY_END = 8:00–21:00 local — what came
 * out at night arrives in the morning), 🌙 night-time (the other hours, for
 * people who work nights) or 🕐 any time:
 *
 *   📝 Vyakhya and Shabad commentary, 📚 dictionary words — new AND edited.
 *      An entry is ready once it is approved and nobody has touched it for
 *      QUIET_MINUTES (60): volunteers often fix an entry right after saving
 *      it. Ready entries are gathered into one notification per kind, at most
 *      every MIN_GAP_HOURS (4) in each zone. Each version is announced once.
 *   📖 Today's MukhWak, once the media robot has published it.
 *   📢 Admin announcements ticked "also send as a notification".
 *   🆕 New Ardas in the Sangat (opt-in), gathered like vyakhya.
 *
 * Personal ones go straight to that person's devices:
 *   🙏🏽 replies and ੴ ਸਤਿਨਾਮ on their Ardas, replies to their reply;
 *   🙋🏽 new vyakhya on an Ang they requested;
 *   👥 volunteers: comments / ⚑ flags on their entries, their entry approved
 *      or sent back; Moderators: new reports from the Sangat.
 *
 * Reads stay small (a few per run when nothing happened — Firestore's free
 * plan allows 50,000 a day). State, cursors and the last run's summary live
 * at pushState/main (Admin → 📱 → 🔔 shows it).
 *
 * Env: FIREBASE_PUSH_SA (service-account JSON — Cloud Datastore User +
 * Firebase Cloud Messaging API Admin), PAGES_URL (the media robot's Pages
 * address), DRY_RUN=1 (log, send nothing, write nothing), QUIET_MINUTES,
 * MIN_GAP_HOURS, DAY_START, DAY_END.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Topics sent to everyone who chose them (by zone); the rest are personal. */
export const PUBLIC_TOPICS = ['mukhwak', 'vyakhya', 'kosh', 'news', 'ardasNew'];
const LANGS = ['pa', 'en'];

// ── time zones ─────────────────────────────────────────────────────────
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
/** A device without a usable zone: most of the Sangat is in Punjab. */
const DEFAULT_TZ = 'Asia/Kolkata';
/** "America/Edmonton" → "America.Edmonton" (topic names allow [A-Za-z0-9-_.~%]). */
export const WHEN = ['day', 'night', 'any'];
const whenOf = (w) => (WHEN.includes(w) ? w : 'day');
/** A zone: where × when. "Any time" needs no place: one zone for all. */
export const zoneId = (tz, when = 'day') => (when === 'any' ? 'any'
  : `${tz.replace(/\//g, '.').replace(/\+/g, 'p').replace(/[^A-Za-z0-9.~-]/g, '-')}_${when}`);
export const topicName = (t, lang, zid) => `sl_${t}_${lang === 'en' ? 'en' : 'pa'}_${zid}`;
/** Is it the zone's time to be told? */
export function inWindow(z, now, dayStart = 8, dayEnd = 21) {
  if (z.when === 'any') return true;
  const h = localHour(z.tz, now);
  const day = h >= dayStart && h < dayEnd;
  return z.when === 'night' ? !day : day;
}
export function localHour(tz, now) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now)) % 24;
  } catch { return 12; }
}

// ── small helpers ──────────────────────────────────────────────────────
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
/** Markdown → plain text, for an announcement's body. */
const plain = (s) => String(s ?? '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
const anonName = (lang) => (lang === 'en' ? 'a member of the Sangat' : 'ਸੰਗਤ ਦੇ ਇੱਕ ਮੈਂਬਰ');
const who = (r, lang) => (r.anon || !r.name ? anonName(lang) : r.name);
const logKey = (key) => key.replace(/\//g, '∕');   // a doc id can't hold "/"
/** The latest of each key, in order. */
const lastOfEach = (list) => {
  const m = new Map();
  for (const x of list) { m.delete(x.key); m.set(x.key, x); }
  return [...m.values()];
};

// Gurbani headings (as in src/heading.ts): not the line to show.
const HEADING = /(ੴ|ਮਹਲਾ|ਮਃ|ਰਾਗੁ|ਸਲੋਕ|ਪਉੜੀ|ਅਸਟਪਦੀ|ਕੀ ਵਾਰ|ਕੀ ਬਾਣੀ|ਬਾਣੀ ਭਗਤ|ਭਗਤਾ ਕੀ|ਚਉਪਦੇ|ਦੁਪਦੇ|ਤਿਪਦੇ|ਪੰਚਪਦੇ|ਇਕਤੁਕੇ|ਡਖਣੇ|ਪਹਰੇ|ਥਿਤੀ|ਬਾਰਹ ਮਾਹਾ|ਸੋਹਿਲਾ)/;
export function isHeadingLine(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (/॥\s*[੦-੯]+\s*॥\s*$/.test(t) || /ਰਹਾਉ/.test(t)) return false;
  return t.replace(/[॥।]/g, ' ').split(/\s+/).filter(Boolean).length <= 7 && HEADING.test(t);
}

/** Admin → 🌐 → 🙈 lines visitors don't see yet (src/granthRanges.ts). */
function hiddenFor(ranges) {
  const list = Array.isArray(ranges) ? ranges.filter((r) => r?.from && r?.to) : [];
  return (ang, verseId) => list.some((r) => {
    const a = Number(r.from.ang) || 0, b = Number(r.to.ang) || 0;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (ang < lo || ang > hi) return false;
    if (ang === lo && r.from.verseId && verseId && verseId < r.from.verseId) return false;
    if (ang === hi && r.to.verseId && verseId && verseId > r.to.verseId) return false;
    return true;
  });
}

// ── the words of each notification ────────────────────────────────────
/** "2 new, 1 updated" — each word as [one, many]. */
const counts = (items, newW, editW) => {
  const n = items.filter((i) => !i.edited).length, e = items.length - n;
  const w = (k, [one, many]) => `${k} ${k === 1 ? one : many}`;
  return [n ? w(n, newW) : '', e ? w(e, editW) : ''].filter(Boolean).join(', ');
};

/** Lines for a notification's body, each clipped, up to `max` characters in all. */
const bodyLines = (lines, max = 240) => {
  const out = [];
  let n = 0;
  for (const l of lines) {
    if (n + l.length > max && out.length) { out.push('…'); break; }
    out.push(l); n += l.length + 1;
  }
  return out.join('\n');
};

export const TEXT = {
  /**
   * One entry: its Ang in the title, the line in the body. Several: the Angs
   * in the title, and for each Ang the first line that got meanings.
   */
  vyakhya(items, lang) {
    const pa = lang !== 'en';
    const byAng = new Map();
    for (const i of [...items].sort((a, b) => a.ang - b.ang || a.verseId - b.verseId)) if (!byAng.has(i.ang)) byAng.set(i.ang, i);
    const angs = [...byAng.keys()];
    const first = byAng.get(angs[0]);
    if (items.length === 1) {
      const shabad = first.scope === 'shabad';
      const what = pa
        ? (shabad ? (first.edited ? 'ਸ਼ਬਦ ਦਾ ਸੋਧਿਆ ਪ੍ਰਸੰਗ' : 'ਸ਼ਬਦ ਦਾ ਨਵਾਂ ਪ੍ਰਸੰਗ') : (first.edited ? 'ਸੋਧੀ ਹੋਈ ਵਿਆਖਿਆ' : 'ਨਵੀਂ ਵਿਆਖਿਆ'))
        : (shabad ? (first.edited ? 'Updated Shabad commentary' : 'New Shabad commentary') : (first.edited ? 'Updated vyakhya' : 'New vyakhya'));
      return {
        title: `📝 ${what} · ${pa ? 'ਅੰਗ' : 'Ang'} ${first.ang}`,
        body: clip(first.line, 200) || (pa ? 'ਸੇਵਾਲੇਖ ਉੱਤੇ ਪੜ੍ਹੋ' : 'Read it on SevaLekh'),
        url: `/#/read/${first.ang}${first.verseId ? `/${first.verseId}` : ''}`,
      };
    }
    const angList = angs.slice(0, 6).join(', ') + (angs.length > 6 ? ' …' : '');
    const head = pa ? `📝 ਵਿਆਖਿਆ: ${counts(items, ['ਨਵੀਂ', 'ਨਵੀਆਂ'], ['ਸੋਧੀ', 'ਸੋਧੀਆਂ'])}` : `📝 Vyakhya: ${counts(items, ['new', 'new'], ['updated', 'updated'])}`;
    return {
      title: `${head} · ${pa ? 'ਅੰਗ' : angs.length === 1 ? 'Ang' : 'Angs'} ${angList}`,
      body: angs.length === 1
        ? bodyLines([...items].sort((a, b) => a.verseId - b.verseId).map((i) => clip(i.line, 90)))
        : bodyLines(angs.map((a) => `${pa ? 'ਅੰਗ' : 'Ang'} ${a} — ${clip(byAng.get(a).line, 70)}`)),
      url: `/#/read/${first.ang}${first.verseId ? `/${first.verseId}` : ''}`,
    };
  },
  /** The words themselves, each with its meaning. */
  kosh(items, lang) {
    const pa = lang !== 'en';
    const url = `/#/dictionary/${encodeURIComponent(items[0].word)}`;
    const meaning = (d) => (pa ? d.pa || d.en : d.en || d.pa);
    if (items.length === 1) {
      const d = items[0];
      return {
        title: pa ? `📚 ਸ਼ਬਦਕੋਸ਼ ਵਿੱਚ ${d.edited ? 'ਸੋਧਿਆ' : 'ਨਵਾਂ'} ਸ਼ਬਦ: ${d.word}` : `📚 ${d.edited ? 'Updated' : 'New'} in the dictionary: ${d.word}`,
        body: clip(meaning(d), 200),
        url,
      };
    }
    const words = items.map((d) => d.word);
    return {
      title: clip(pa ? `📚 ਸ਼ਬਦਕੋਸ਼: ${counts(items, ['ਨਵਾਂ', 'ਨਵੇਂ'], ['ਸੋਧਿਆ', 'ਸੋਧੇ'])} — ${words.join(', ')}`
        : `📚 Dictionary: ${counts(items, ['new', 'new'], ['updated', 'updated'])} — ${words.join(', ')}`, 110),
      body: bodyLines(items.map((d) => `${d.word} — ${clip(meaning(d), 60)}`)),
      url,
    };
  },
  mukhwak(m, lang) {
    const pa = lang !== 'en';
    return {
      title: pa ? `📖 ਅੱਜ ਦਾ ਮੁੱਖਵਾਕ · ਅੰਗ ${m.ang}` : `📖 Today’s MukhWak · Ang ${m.ang}`,
      body: clip(m.line, 140) || (pa ? 'ਵਿਆਖਿਆ ਤੇ ਆਡੀਓ ਸਮੇਤ' : 'With vyakhya and audio'),
      url: '/#/mukhwak',
    };
  },
  /** An Admin's news: the Punjabi version for Punjabi phones when there is one. */
  news(a, lang) {
    const pa = lang !== 'en' && a.titlePa;
    const t = clip(pa ? a.titlePa : a.title, 90);
    return {
      title: /^\p{Extended_Pictographic}/u.test(t) ? t : `📢 ${t}`,
      body: clip(plain(pa ? a.bodyPa : a.body), 180), url: a.url || '/', tag: `news-${a.id}`,
    };
  },
  ardasNew(list, lang) {
    const pa = lang !== 'en';
    if (list.length === 1) {
      return { title: pa ? '🆕 ਸੰਗਤ ਵਿੱਚ ਨਵੀਂ ਅਰਦਾਸ' : '🆕 A new Ardas in the Sangat', body: clip(list[0].text, 140), url: `/#/ardas/${list[0].id}` };
    }
    return {
      title: pa ? `🆕 ਸੰਗਤ ਵਿੱਚ ${list.length} ਨਵੀਆਂ ਅਰਦਾਸਾਂ` : `🆕 ${list.length} new Ardas in the Sangat`,
      body: clip(list[list.length - 1].text, 140), url: '/#/ardas',
    };
  },
  /** The writer of an Ardas: replies and ੴ ਸਤਿਨਾਮ since last time. */
  ardasOwner(x, lang) {
    const pa = lang !== 'en';
    const parts = [];
    if (x.satnaam) parts.push(pa ? `${x.satnaam} ਵਾਰ ੴ ਸਤਿਨਾਮ` : `${x.satnaam} × ੴ ਸਤਿਨਾਮ`);
    if (x.replies) parts.push(pa ? `${x.replies} ਜਵਾਬ` : `${x.replies} repl${x.replies === 1 ? 'y' : 'ies'}`);
    const last = x.last ? ` — ${who(x.last, lang)}: ${clip(x.last.text, 90)}` : '';
    return {
      title: pa ? '🙏🏽 ਤੁਹਾਡੀ ਅਰਦਾਸ ਉੱਤੇ ਸੰਗਤ' : '🙏🏽 The Sangat on your Ardas',
      body: clip(parts.join(' · ') + last, 170),
      url: `/#/ardas/${x.ardasId}`,
      tag: `ardas-${x.ardasId}`,
    };
  },
  replyToYou(x, lang) {
    const pa = lang !== 'en';
    return {
      title: pa ? '↪ ਤੁਹਾਡੇ ਜਵਾਬ ਦਾ ਜਵਾਬ' : '↪ A reply to you',
      body: clip(`${who(x.last, lang)}: ${x.last.text}`, 170),
      url: `/#/ardas/${x.ardasId}`,
      tag: `ardas-${x.ardasId}`,
    };
  },
  requests(angs, lang) {
    const pa = lang !== 'en';
    const list = angs.slice(0, 6).join(', ');
    return {
      title: pa ? '🙋🏽 ਤੁਹਾਡੀ ਮੰਗੀ ਵਿਆਖਿਆ' : '🙋🏽 The vyakhya you asked for',
      body: pa ? `ਤੁਹਾਡੇ ਮੰਗੇ ${angs.length === 1 ? 'ਅੰਗ' : 'ਅੰਗਾਂ'} ${list} ਉੱਤੇ ਨਵੀਂ ਵਿਆਖਿਆ ਆਈ ਹੈ।`
        : `New vyakhya on ${angs.length === 1 ? 'Ang' : 'Angs'} ${list}, which you asked for.`,
      url: `/#/read/${angs[0]}`,
    };
  },
  /** Volunteers: lines collected for one person. */
  team(lines, lang) {
    const pa = lang !== 'en';
    if (lines.length === 1) return { title: `👥 ${lines[0].title[pa ? 'pa' : 'en']}`, body: clip(lines[0].body, 170), url: lines[0].url, tag: 'team' };
    return {
      title: pa ? `👥 ਸੇਵਾ: ${lines.length} ਨਵੀਆਂ ਗੱਲਾਂ` : `👥 Seva: ${lines.length} new things`,
      body: clip(lines.map((l) => l.title[pa ? 'pa' : 'en']).join(' · '), 170),
      url: '/#/notifications', tag: 'team',
    };
  },
};

/** How long FCM keeps trying a phone that is off (seconds). */
const TTL = { mukhwak: 12 * 3600, vyakhya: 86400, kosh: 86400, news: 2 * 86400, ardasNew: 12 * 3600, ardas: 3 * 86400, requests: 3 * 86400, team: 3 * 86400 };

export const message = (target, n, kind, lang) => ({
  ...target,
  webpush: {
    headers: { TTL: String(TTL[kind] ?? 86400), Urgency: kind === 'ardas' || kind === 'team' ? 'high' : 'normal' },
    data: {
      title: n.title, body: n.body || '', url: n.url || '/', tag: n.tag || kind, lang: lang === 'en' ? 'en' : 'pa', kind,
    },
  },
});

const BAD_TOKEN = /registration-token-not-registered|invalid-registration-token|invalid-argument|mismatched-credential|third-party-auth-error/;

// ── the run ───────────────────────────────────────────────────────────
/**
 * One pass. `ctx`: { db (firebase-admin Firestore), messaging (FCM: send,
 * sendEach, subscribeToTopic, unsubscribeFromTopic), now, fetchJson(url), log,
 * dry, quietMs, gapMs, dayStart, dayEnd, pagesUrl }.
 */
export async function run(ctx) {
  const { db, messaging, log = console.log, dry = false } = ctx;
  const now = ctx.now ?? Date.now();
  const quietMs = ctx.quietMs ?? 60 * MIN;
  const gapMs = ctx.gapMs ?? 4 * HOUR;
  const dayStart = ctx.dayStart ?? 8, dayEnd = ctx.dayEnd ?? 21;
  const fetchJson = ctx.fetchJson ?? (async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    return r.json();
  });

  const stateRef = db.doc('pushState/main');
  const snap = await stateRef.get();
  const fresh = !snap.exists;
  // First run: start from now — never a flood of old news.
  const S = {
    feedAt: now, repliesAt: now, satnaamAt: now, ardasAt: now, reportsAt: now, annAt: now,
    pending: {}, digest: {}, zones: {}, mukhwak: null, prunedAt: 0,
    ...(snap.exists ? snap.data() : {}),
  };
  S.pending ??= {}; S.zones ??= {};
  S.digest = { vyakhya: [], kosh: [], ardasNew: [], news: [], ...(S.digest ?? {}) };
  const sent = [];      // summary lines
  let sends = 0;
  const save = async (extra = {}) => {
    if (dry) return;
    await stateRef.set({ ...S, ...extra, lastRun: now });
  };
  /** A zone the robot sends to — new ones start "now" (no backlog). */
  const zone = (tz, when) => {
    const id = zoneId(tz, when);
    // since: only what is newer than this; sentAt: the last digest (the gap is counted from it).
    S.zones[id] ??= { tz: when === 'any' ? 'UTC' : tz, when, since: { vyakhya: now, kosh: now, ardasNew: now, news: now }, sentAt: {}, mukhwak: S.mukhwak?.date ?? '' };
    return id;
  };

  // Lines an Admin keeps from visitors for now (🙈) are not announced.
  const pub = (await db.doc('settings/public').get()).data() ?? {};
  const hidden = hiddenFor(pub.hidden);

  // ── sending ──
  const sendTopic = async (kind, zid, build) => {
    for (const lang of LANGS) {
      const n = build(lang);
      const m = message({ topic: topicName(kind, lang, zid) }, n, kind, lang);
      log(`→ ${m.topic}: ${n.title} | ${n.body}`);
      if (!dry) await messaging.send(m);
      sends++;
    }
  };
  const tokensOf = new Map();
  const userTokens = async (uid) => {
    if (!tokensOf.has(uid)) {
      const s = await db.collection('pushTokens').where('uid', '==', uid).get();
      tokensOf.set(uid, s.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    return tokensOf.get(uid);
  };
  const dropTokens = async (ids) => {
    if (dry || !ids.length) return;
    const b = db.batch();
    for (const id of ids) { b.delete(db.doc(`pushTokens/${id}`)); b.delete(db.doc(`pushSubs/${id}`)); }
    await b.commit();
  };
  /** To these devices, each in its language (500 per call). Returns how many got it. */
  const sendTokens = async (toks, kind, build, label) => {
    if (!toks.length) return 0;
    const msgs = toks.map((t) => message({ token: t.id }, build(t.lang), kind, t.lang));
    log(`→ ${kind} ${label} (${toks.length} device${toks.length > 1 ? 's' : ''}): ${msgs[0].webpush.data.title} | ${msgs[0].webpush.data.body}`);
    sends += msgs.length;
    if (dry) return toks.length;
    let ok = 0;
    for (let i = 0; i < msgs.length; i += 500) {
      const res = await messaging.sendEach(msgs.slice(i, i + 500));
      const bad = [];
      res.responses.forEach((r, j) => {
        if (r.success) ok++;
        else if (BAD_TOKEN.test(r.error?.code ?? '')) bad.push(toks[i + j].id);
      });
      await dropTokens(bad);
    }
    return ok;
  };
  /** To one person's devices that chose `kind`. */
  const sendUser = async (uid, kind, build) => {
    if (!uid) return 0;
    const toks = (await userTokens(uid)).filter((t) => Array.isArray(t.topics) && t.topics.includes(kind));
    return sendTokens(toks, kind, build, `for ${uid.slice(0, 6)}…`);
  };

  // ── 1. topic subscriptions (kind × language × time zone) ──
  {
    const dirty = await db.collection('pushTokens').where('dirty', '==', true).limit(1000).get();
    if (!dirty.empty) {
      const subs = await db.getAll(...dirty.docs.map((d) => db.doc(`pushSubs/${d.id}`)));
      const add = {}, remove = {};
      const want = new Map();
      dirty.docs.forEach((d, i) => {
        const t = d.data();
        const tz = validTz(t.tz) ? t.tz : DEFAULT_TZ;
        const zid = zoneId(tz, whenOf(t.when));
        const w = (Array.isArray(t.topics) ? t.topics : []).filter((x) => PUBLIC_TOPICS.includes(x)).map((x) => topicName(x, t.lang, zid));
        if (w.length) {
          // Which kinds the zone's devices chose: no sends to a zone nobody listens to for that kind.
          const z = S.zones[zone(tz, whenOf(t.when))];
          z.kinds = [...new Set([...(z.kinds ?? []), ...t.topics.filter((x) => PUBLIC_TOPICS.includes(x))])];
        }
        const have = subs[i].exists ? subs[i].data().topics ?? [] : [];
        want.set(d.id, w);
        for (const x of w) if (!have.includes(x)) (add[x] ??= []).push(d.id);
        for (const x of have) if (!w.includes(x)) (remove[x] ??= []).push(d.id);
      });
      const bad = new Set();
      const apply = async (map, fn) => {
        for (const [topic, toks] of Object.entries(map)) {
          for (let i = 0; i < toks.length; i += 1000) {
            const part = toks.slice(i, i + 1000);
            if (dry) { log(`(dry) ${fn} ${part.length} → ${topic}`); continue; }
            const r = await messaging[fn](part, topic);
            for (const e of r.errors ?? []) if (BAD_TOKEN.test(e.error?.code ?? '')) bad.add(part[e.index]);
          }
        }
      };
      await apply(add, 'subscribeToTopic');
      await apply(remove, 'unsubscribeFromTopic');
      if (!dry) {
        for (const d of dirty.docs) {
          const t = d.data();
          if (bad.has(d.id) || !(Array.isArray(t.topics) && t.topics.length)) {
            // Turned off on the device, or no longer a valid token: forget it.
            await db.doc(`pushTokens/${d.id}`).delete({ lastUpdateTime: d.updateTime }).catch(() => {});
            await db.doc(`pushSubs/${d.id}`).delete().catch(() => {});
            continue;
          }
          await db.doc(`pushSubs/${d.id}`).set({ topics: want.get(d.id), at: now });
          // Only if the device hasn't written again meanwhile (else: next run).
          await db.doc(`pushTokens/${d.id}`).update({ dirty: false }, { lastUpdateTime: d.updateTime }).catch(() => {});
        }
      }
      log(`Subscriptions: ${dirty.size} device${dirty.size > 1 ? 's' : ''} updated${bad.size ? `, ${bad.size} gone` : ''}.`);
    }
  }

  // ── 2. the team's feed: what changed, and volunteers' own news ──
  const teamLines = new Map();   // uid → [{ title: {pa, en}, body, url }]
  const addTeam = (uid, line) => { if (uid) (teamLines.get(uid) ?? teamLines.set(uid, []).get(uid)).push(line); };
  const docCache = new Map();
  const getDocs = async (paths) => {
    const need = [...new Set(paths)].filter((p) => !docCache.has(p));
    for (let i = 0; i < need.length; i += 300) {
      const part = need.slice(i, i + 300);
      const got = await db.getAll(...part.map((p) => db.doc(p)));
      got.forEach((g, j) => docCache.set(part[j], g.exists ? g.data() : null));
    }
    return paths.map((p) => docCache.get(p));
  };
  const pathOf = (k) => {
    const key = k.replace(/∕/g, '/');
    return key.startsWith('d:') ? `definitions/${key.slice(2)}` : `interpretations/${key.slice(2)}`;
  };
  {
    const feed = await db.collection('notifications').where('createdAt', '>', S.feedAt).orderBy('createdAt').limit(500).get();
    const teamEvents = [];
    for (const d of feed.docs) {
      const n = d.data();
      S.feedAt = Math.max(S.feedAt, Number(n.createdAt) || 0);
      const iid = String(n.interpretationId ?? '');
      const key = iid.startsWith('definitions/') ? `d:${iid.slice('definitions/'.length)}`
        : /^G-/.test(iid) ? `i:${iid}` : '';
      if (!key) continue;
      const k = logKey(key);
      if (n.type === 'deleted') { delete S.pending[k]; continue; }
      if (['new', 'edited', 'status', 'reverted'].includes(n.type)) {
        const p = S.pending[k];
        S.pending[k] = {
          first: p?.first ?? n.createdAt,
          last: Math.max(p?.last ?? 0, n.createdAt),
          // Added, or approved just now: "new" to readers. Only edits: "updated".
          isNew: !!p?.isNew || n.type === 'new' || n.type === 'status',
        };
      }
      if (n.type === 'commented' || n.type === 'status' || n.type === 'reverted') teamEvents.push({ n, key });
    }
    // 👥 Comments and decisions on someone's own entry (not their own doing).
    const docs = await getDocs(teamEvents.map((e) => pathOf(e.key)));
    teamEvents.forEach(({ n, key }, i) => {
      const it = docs[i];
      if (!it || !it.createdBy || it.createdBy === n.actorUid) return;
      const word = key.startsWith('d:') ? key.slice(2) : '';
      const where = word ? { pa: `“${word}”`, en: `“${word}”` } : { pa: `ਅੰਗ ${n.ang}`, en: `Ang ${n.ang}` };
      const url = word ? `/#/dictionary/${encodeURIComponent(word)}` : `/#/read/${n.ang}${n.verseId ? `/${n.verseId}` : ''}`;
      const actor = n.actorName || '';
      if (n.type === 'commented') {
        const flag = /⚑/.test(n.summary ?? '');
        const text = (String(n.summary ?? '').match(/"(.*)"$/) ?? [])[1] ?? '';
        addTeam(it.createdBy, {
          title: flag ? { pa: `⚑ ${actor} ਨੇ ਧਿਆਨ ਦਿਵਾਇਆ · ${where.pa}`, en: `⚑ ${actor} flagged your entry · ${where.en}` }
            : { pa: `💬 ${actor} ਦੀ ਟਿੱਪਣੀ · ${where.pa}`, en: `💬 ${actor} commented · ${where.en}` },
          body: text, url,
        });
      } else if (n.type === 'reverted') {
        addTeam(it.createdBy, { title: { pa: `↩ ${actor} ਨੇ ਪਿਛਲਾ ਰੂਪ ਮੋੜਿਆ · ${where.pa}`, en: `↩ ${actor} restored an earlier version · ${where.en}` }, body: '', url });
      } else if (it.status === 'approved' || it.status === 'rejected') {
        const ok = it.status === 'approved';
        addTeam(it.createdBy, {
          title: ok ? { pa: `✅ ਮਨਜ਼ੂਰ · ${where.pa}`, en: `✅ Approved · ${where.en}` }
            : { pa: `↩ ਸੋਧ ਲਈ ਵਾਪਸ · ${where.pa}`, en: `↩ Sent back for changes · ${where.en}` },
          body: ok ? (word ? '' : clip(it.verseGurmukhi, 120)) : actor, url,
        });
      }
    });
  }

  // ── 3. which entries are ready: approved, an hour quiet, this version not yet announced ──
  {
    const keys = Object.keys(S.pending).slice(0, 400);
    const items = await getDocs(keys.map(pathOf));
    const logs = keys.length ? await db.getAll(...keys.map((k) => db.doc(`pushLog/${k}`))) : [];
    const ready = [];
    keys.forEach((k, i) => {
      const it = items[i];
      const p = S.pending[k];
      const isDef = k.startsWith('d:');
      const approved = it && (isDef ? (!it.status || it.status === 'approved') : it.status === 'approved');
      // Not (or no longer) approved: an approval later brings it back.
      if (!approved) { delete S.pending[k]; return; }
      const touched = Math.max(Number(it.lastEditedAt) || 0, p.last || 0);
      if (now - touched < quietMs) return;              // still being worked on: wait
      delete S.pending[k];
      const v = Number(it.currentVersion) || 0;
      const logged = logs[i].exists ? logs[i].data() : null;
      if (logged && (Number(logged.v) || 0) >= v && v > 0) return;   // this version was announced
      const edited = !p.isNew || !!logged;
      if (isDef) {
        S.digest.kosh.push({ key: k, word: it.word ?? k.slice(2), pa: clip(it.punjabi, 160), en: clip(it.english, 160), edited, at: now });
      } else {
        const ang = Number(it.ang) || 0, verseId = Number(it.verseId) || 0;
        if (!hidden(ang, verseId)) {
          S.digest.vyakhya.push({ key: k, ang, verseId, scope: it.scope ?? 'verse', line: clip(it.verseGurmukhi, 160), edited, at: now });
        }
      }
      ready.push({ key: k, v, edited, isDef, ang: Number(it.ang) || 0, verseId: Number(it.verseId) || 0 });
    });
    if (!dry && ready.length) {
      for (let i = 0; i < ready.length; i += 400) {
        const b = db.batch();
        for (const x of ready.slice(i, i + 400)) b.set(db.doc(`pushLog/${x.key}`), { v: x.v, at: now });
        await b.commit();
      }
    }
    // 🙋🏽 New vyakhya on a requested Ang: each requester once, with all their Angs.
    const angs = [...new Set(ready.filter((x) => !x.isDef && !x.edited && !hidden(x.ang, x.verseId)).map((x) => x.ang))];
    if (angs.length) {
      const reqs = await getDocs(angs.map((a) => `angRequests/${a}`));
      const byUser = new Map();
      reqs.forEach((r, i) => { for (const uid of r?.requesters ?? []) (byUser.get(uid) ?? byUser.set(uid, []).get(uid)).push(angs[i]); });
      let n = 0;
      for (const [uid, a] of byUser) n += (await sendUser(uid, 'requests', (lang) => TEXT.requests(a, lang))) ? 1 : 0;
      if (n) sent.push(`🙋🏽 ${n} requester${n > 1 ? 's' : ''}`);
    }
    await save();
  }

  // ── 4. 📖 MukhWak: noted here, sent in each zone's daytime (section 7) ──
  if (ctx.pagesUrl) {
    try {
      const j = await fetchJson(`${ctx.pagesUrl.replace(/\/$/, '')}/mukhwak/latest.json?x=${now}`);
      const date = String(j?.date ?? '');
      // A remake after edited meanings keeps the date: one notification a day.
      if (date && date !== S.mukhwak?.date) {
        let line = '';
        try {
          const [y, m, d] = date.split('-').map(Number);
          const h = await fetchJson(`https://api.banidb.com/v2/hukamnamas/${y}/${m}/${d}`);
          const lines = (h?.shabads ?? []).flatMap((s) => (s?.verses ?? []).map((v) => v?.verse?.unicode ?? v?.verse?.gurmukhi ?? ''));
          line = lines.find((l) => l && !isHeadingLine(l)) ?? '';
        } catch (e) { log(`BaniDB: ${e.message}`); }
        // On the very first run, today's is old news.
        S.mukhwak = { date, ang: Number(j.ang) || 0, line: clip(line, 160), at: fresh ? 0 : now };
        if (fresh) for (const z of Object.values(S.zones)) z.mukhwak = date;
      }
    } catch (e) { log(`MukhWak: ${e.message}`); }
  }

  // ── 5. 📢 announcements ──
  {
    const a = await db.collection('announcements').where('createdAt', '>', S.annAt).orderBy('createdAt').limit(10).get();
    for (const d of a.docs) {
      const x = d.data();
      S.annAt = Math.max(S.annAt, Number(x.createdAt) || 0);
      if (x.push !== true || x.active === false) continue;
      S.digest.news.push({ key: d.id, id: d.id, title: clip(x.title, 120), body: clip(plain(x.body), 300), at: now });
    }
    // An Admin's "send a notification" (also the Important Notice and the app update).
    const ob = await db.collection('pushOutbox').where('done', '==', false).limit(10).get();
    for (const d of ob.docs) {
      const x = d.data();
      const note = {
        key: d.id, id: d.id, title: clip(x.title, 120), body: clip(x.body, 400), url: String(x.url || '/'), at: now,
        ...(x.titlePa ? { titlePa: clip(x.titlePa, 120), bodyPa: clip(x.bodyPa, 400) } : {}),
      };
      let n = null;
      if (x.audience === 'team') {
        const mem = await db.collection('members').where('status', '==', 'active').get();
        n = 0;
        for (const m of mem.docs) if (Number(m.data().role) >= 2) n += await sendUser(m.id, 'team', (lang) => TEXT.news(note, lang));
      } else if (x.audience === 'android-app') {
        const toks = await db.collection('pushTokens').where('platform', '==', 'android-app').get();
        n = await sendTokens(toks.docs.map((t) => ({ id: t.id, ...t.data() })).filter((t) => Array.isArray(t.topics) && t.topics.length),
          'news', (lang) => TEXT.news(note, lang), 'to Android apps');
      } else {
        S.digest.news.push(note);          // everyone: by zone, in their chosen hours
      }
      if (n !== null) sent.push(`📢 ${n} device${n === 1 ? '' : 's'} (${x.audience})`);
      if (!dry) await d.ref.update({ done: true, doneAt: now, ...(n !== null ? { sent: n } : {}) });
    }
  }

  // ── 6. 🙏🏽 the Sangat ──
  {
    const owners = new Map();   // ardasOwners key → uid | null
    const ownerOf = async (keys) => {
      const need = [...new Set(keys)].filter((k) => !owners.has(k));
      if (need.length) {
        const got = await db.getAll(...need.map((k) => db.doc(`ardasOwners/${k}`)));
        got.forEach((g, i) => owners.set(need[i], g.exists ? g.data().uid ?? null : null));
      }
      return keys.map((k) => owners.get(k));
    };
    const [rs, ss] = await Promise.all([
      db.collectionGroup('replies').where('at', '>', S.repliesAt).orderBy('at').limit(500).get(),
      db.collectionGroup('satnaam').where('at', '>', S.satnaamAt).orderBy('at').limit(1000).get(),
    ]);
    const replies = rs.docs.map((d) => ({ id: d.id, ardasId: d.ref.parent.parent?.id, ...d.data() })).filter((r) => r.ardasId);
    const sat = ss.docs.map((d) => ({ uid: d.id, ardasId: d.ref.parent.parent?.id, at: d.data().at })).filter((r) => r.ardasId);
    for (const r of replies) S.repliesAt = Math.max(S.repliesAt, Number(r.at) || 0);
    for (const s of sat) S.satnaamAt = Math.max(S.satnaamAt, Number(s.at) || 0);
    const ardasIds = [...new Set([...replies, ...sat].map((x) => x.ardasId))];
    const ardasDocs = await getDocs(ardasIds.map((id) => `ardas/${id}`));
    const live = new Set(ardasIds.filter((id, i) => ardasDocs[i] && ardasDocs[i].hidden !== true));
    const ownerUids = await ownerOf(ardasIds);
    const ownerById = new Map(ardasIds.map((id, i) => [id, ownerUids[i]]));
    const replyOwners = await ownerOf(replies.map((r) => `${r.ardasId}_${r.id}`));
    const withTo = replies.filter((r) => r.replyTo?.id);
    const toOwnerList = await ownerOf(withTo.map((r) => `${r.ardasId}_${r.replyTo.id}`));
    const toOwner = new Map(withTo.map((r, i) => [r, toOwnerList[i]]));

    const forOwner = new Map();   // `${uid}|${ardasId}` → { uid, ardasId, replies, satnaam, last }
    const bump = (uid, ardasId) => {
      const k = `${uid}|${ardasId}`;
      return forOwner.get(k) ?? forOwner.set(k, { uid, ardasId, replies: 0, satnaam: 0, last: null }).get(k);
    };
    const toReply = [];
    replies.forEach((r, i) => {
      if (r.hidden === true || !live.has(r.ardasId)) return;
      const writer = replyOwners[i];
      const owner = ownerById.get(r.ardasId);
      if (owner && owner !== writer) { const x = bump(owner, r.ardasId); x.replies++; x.last = r; }
      const toUid = toOwner.get(r);
      if (toUid && toUid !== writer && toUid !== owner) toReply.push({ uid: toUid, ardasId: r.ardasId, last: r });
    });
    for (const s of sat) {
      const owner = ownerById.get(s.ardasId);
      if (owner && owner !== s.uid && live.has(s.ardasId)) bump(owner, s.ardasId).satnaam++;
    }
    let n = 0;
    for (const x of forOwner.values()) n += (await sendUser(x.uid, 'ardas', (lang) => TEXT.ardasOwner(x, lang))) ? 1 : 0;
    for (const x of toReply) n += (await sendUser(x.uid, 'ardas', (lang) => TEXT.replyToYou(x, lang))) ? 1 : 0;
    if (n) sent.push(`🙏🏽 ${n} Ardas update${n > 1 ? 's' : ''}`);

    // 🆕 new Ardas → the zones' digests
    const na = await db.collection('ardas').where('at', '>', S.ardasAt).orderBy('at').limit(50).get();
    for (const d of na.docs) {
      const a = d.data();
      S.ardasAt = Math.max(S.ardasAt, Number(a.at) || 0);
      if (a.hidden !== true) S.digest.ardasNew.push({ key: d.id, id: d.id, text: clip(a.text, 160), at: now });
    }

    // ⚑ reports → Moderators and Admins
    const rep = await db.collection('ardasReports').where('at', '>', S.reportsAt).orderBy('at').limit(50).get();
    if (!rep.empty) {
      for (const d of rep.docs) S.reportsAt = Math.max(S.reportsAt, Number(d.data().at) || 0);
      const mods = await db.collection('members').where('role', 'in', [4, 5, '4', '5']).get();
      const r0 = rep.docs[rep.docs.length - 1].data();
      for (const m of mods.docs) {
        if (m.data().status !== 'active') continue;
        addTeam(m.id, {
          title: rep.size === 1 ? { pa: '⚑ ਸੰਗਤ ਵਿੱਚੋਂ ਨਵੀਂ ਰਿਪੋਰਟ', en: '⚑ A new report from the Sangat' }
            : { pa: `⚑ ਸੰਗਤ ਵਿੱਚੋਂ ${rep.size} ਨਵੀਆਂ ਰਿਪੋਰਟਾਂ`, en: `⚑ ${rep.size} new reports from the Sangat` },
          body: clip(r0.why, 140), url: `/#/ardas/${r0.ardasId}`,
        });
      }
    }
    await save();
  }

  // ── 7. each zone, in its chosen hours ──
  {
    const tally = {};
    for (const [zid, z] of Object.entries(S.zones)) {
      z.when = whenOf(z.when);
      if (!validTz(z.tz) || !inWindow(z, now, dayStart, dayEnd)) continue;
      z.since ??= {}; z.sentAt ??= {};
      const wants = (k) => !z.kinds || z.kinds.includes(k);
      for (const kind of ['vyakhya', 'kosh', 'ardasNew']) {
        if (!wants(kind) || now - (z.sentAt[kind] ?? 0) < gapMs) continue;   // at most every MIN_GAP_HOURS
        const items = lastOfEach(S.digest[kind].filter((x) => x.at > (z.since[kind] ?? now)));
        if (!items.length) continue;
        const list = kind === 'vyakhya' ? items.sort((a, b) => a.ang - b.ang || a.verseId - b.verseId) : items;
        await sendTopic(kind, zid, (lang) => TEXT[kind](list, lang));
        z.since[kind] = now; z.sentAt[kind] = now;
        tally[kind] = (tally[kind] ?? 0) + 1;
      }
      // 📢 news: rare, so each one goes as it is (no gap) — up to 3 at a time.
      const news = wants('news') ? S.digest.news.filter((x) => x.at > (z.since.news ?? now)).slice(-3) : [];
      for (const a of news) { await sendTopic('news', zid, (lang) => TEXT.news(a, lang)); tally.news = (tally.news ?? 0) + 1; }
      if (news.length) z.since.news = now;
      if (wants('mukhwak') && S.mukhwak?.date && z.mukhwak !== S.mukhwak.date && now - (S.mukhwak.at || 0) < 20 * HOUR) {
        await sendTopic('mukhwak', zid, (lang) => TEXT.mukhwak(S.mukhwak, lang));
        z.mukhwak = S.mukhwak.date;
        tally.mukhwak = (tally.mukhwak ?? 0) + 1;
      }
    }
    const label = { vyakhya: '📝 vyakhya', kosh: '📚 words', ardasNew: '🆕 Ardas', news: '📢 news', mukhwak: '📖 MukhWak' };
    for (const [k, n] of Object.entries(tally)) sent.push(`${label[k]} → ${n} zone${n > 1 ? 's' : ''}`);
    // What every zone has had (or is too old to matter now) leaves the digests.
    const keep = { vyakhya: 2 * DAY, kosh: 2 * DAY, ardasNew: DAY, news: 3 * DAY };
    for (const k of Object.keys(keep)) S.digest[k] = S.digest[k].filter((x) => now - x.at < keep[k]).slice(-1500);
  }

  // ── 8. 👥 volunteers ──
  {
    let n = 0;
    for (const [uid, lines] of teamLines) n += (await sendUser(uid, 'team', (lang) => TEXT.team(lines, lang))) ? 1 : 0;
    if (n) sent.push(`👥 ${n} volunteer${n > 1 ? 's' : ''}`);
  }

  // ── 9. once a day: forget devices not seen for 75 days (the app checks in weekly) ──
  if (!dry && now - (S.prunedAt ?? 0) > DAY) {
    const old = await db.collection('pushTokens').where('at', '<', now - 75 * DAY).limit(300).get();
    if (!old.empty) {
      const subs = await db.getAll(...old.docs.map((d) => db.doc(`pushSubs/${d.id}`)));
      const by = {};
      subs.forEach((s, i) => { for (const t of (s.exists ? s.data().topics ?? [] : [])) (by[t] ??= []).push(old.docs[i].id); });
      for (const [t, toks] of Object.entries(by)) await messaging.unsubscribeFromTopic(toks, t).catch(() => {});
      await dropTokens(old.docs.map((d) => d.id));
      log(`Forgot ${old.size} device${old.size > 1 ? 's' : ''} not seen for 75 days.`);
    }
    S.prunedAt = now;
  }

  const summary = sent.join(' · ');
  log(summary ? `Sent: ${summary} (${sends} message${sends > 1 ? 's' : ''})` : 'Nothing to send.');
  await save(sent.length ? { lastSent: now, lastSummary: summary, lastError: '' } : { lastError: '' });
  return { sent, sends, state: S };
}

// ── from the command line / GitHub Actions ────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.env.FIREBASE_PUSH_SA ?? '';
  if (!raw.trim()) {
    console.log('::warning::🔔 Notifications are not set up: add the repository secret FIREBASE_PUSH_SA (see README → Notifications).');
    process.exit(0);
  }
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getMessaging } = await import('firebase-admin/messaging');
  // The key file as it is, or base64 of it; a byte-order mark or stray spaces don't matter.
  const parse = (t) => JSON.parse(t.replace(/^\uFEFF/, '').trim());
  let sa;
  try { sa = parse(raw); } catch {
    try { sa = parse(Buffer.from(raw.trim(), 'base64').toString('utf8')); } catch {
      const t = raw.trim();
      console.log(`::error::FIREBASE_PUSH_SA is not valid JSON (${t.length} characters, starts "${t.slice(0, 1)}", ends "${t.slice(-1)}") — paste the whole key file.`);
      process.exit(1);
    }
  }
  const app = initializeApp({ credential: cert(sa), projectId: sa.project_id });
  const db = getFirestore(app);
  const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  try {
    await run({
      db, messaging: getMessaging(app),
      dry: process.env.DRY_RUN === '1',
      pagesUrl: process.env.PAGES_URL || '',
      quietMs: num(process.env.QUIET_MINUTES, 60) * MIN,
      gapMs: num(process.env.MIN_GAP_HOURS, 4) * HOUR,
      dayStart: num(process.env.DAY_START, 8),
      dayEnd: num(process.env.DAY_END, 21),
    });
  } catch (e) {
    console.log(`::error::${e?.message ?? e}`);
    if (process.env.DRY_RUN !== '1') {
      await db.doc('pushState/main').set({ lastError: String(e?.message ?? e).slice(0, 300), lastRun: Date.now() }, { merge: true }).catch(() => {});
    }
    process.exit(1);
  }
}
