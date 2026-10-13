/**
 * npm test — the notification robot against an in-memory Firestore and FCM.
 * One story through a day: devices sign up, volunteers add and edit, the
 * Sangat replies, an Admin sends news; each zone hears in its own hours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, zoneId, topicName, localHour, inWindow, isHeadingLine, TEXT } from './push.mjs';
import { FakeDb, FakeMessaging } from './fake-firestore.mjs';

const MIN = 60_000, H = 60 * MIN;
// 18:00 UTC: 12:00 in Edmonton (MDT), 23:30 in Kolkata.
const T0 = Date.parse('2026-10-12T18:00:00Z');

const ED_DAY = zoneId('America/Edmonton', 'day');
const KO_DAY = zoneId('Asia/Kolkata', 'day');
const KO_NIGHT = zoneId('Asia/Kolkata', 'night');

function world() {
  const db = new FakeDb();
  const fcm = new FakeMessaging();
  let mukhwak = { date: '2026-10-12', ang: 600, made: new Date(T0 - 3 * H).toISOString() };
  const fetchJson = async (u) => {
    if (u.includes('latest.json')) return mukhwak;
    if (u.includes('banidb')) return { shabads: [{ verses: [{ verse: { unicode: 'ਸੋਰਠਿ ਮਹਲਾ ੫ ॥' } }, { verse: { unicode: 'ਗੁਰਿ ਪੂਰੈ ਕਿਰਪਾ ਧਾਰੀ ॥' } }] }] };
    throw new Error('offline');
  };
  const logs = [];
  const go = (now) => run({ db, messaging: fcm, now, fetchJson, log: (l) => logs.push(l), pagesUrl: 'https://bot.example' });
  const token = (id, d) => db.put(`pushTokens/${id}`, { token: id, uid: null, lang: 'pa', tz: 'America/Edmonton', when: 'day', platform: 'android', at: T0, dirty: true, ...d });
  return { db, fcm, go, token, logs, setMukhwak: (m) => { mukhwak = m; } };
}

test('helpers', () => {
  assert.equal(ED_DAY, 'America.Edmonton_day');
  assert.equal(zoneId('Etc/GMT+5', 'night'), 'Etc.GMTp5_night');
  assert.equal(zoneId('Asia/Kolkata', 'any'), 'any');
  assert.match(topicName('vyakhya', 'en', ED_DAY), /^[A-Za-z0-9_.~%-]+$/);
  assert.equal(localHour('America/Edmonton', T0), 12);
  assert.equal(localHour('Asia/Kolkata', T0), 23);
  assert.equal(inWindow({ tz: 'Asia/Kolkata', when: 'day' }, T0), false);
  assert.equal(inWindow({ tz: 'Asia/Kolkata', when: 'night' }, T0), true);
  assert.equal(inWindow({ tz: 'Asia/Kolkata', when: 'any' }, T0), true);
  assert.equal(isHeadingLine('ਸੋਰਠਿ ਮਹਲਾ ੫ ॥'), true);
  assert.equal(isHeadingLine('ਗੁਰਿ ਪੂਰੈ ਕਿਰਪਾ ਧਾਰੀ ॥'), false);
});

test('a day of notifications', async () => {
  const { db, fcm, go, token } = world();

  // ── first run: remembers where things are, sends nothing ──
  await go(T0);
  assert.equal(fcm.sent.length, 0);
  assert.ok(db.data('pushState/main'));

  // ── devices sign up ──
  token('A', { uid: 'u1', topics: ['mukhwak', 'vyakhya', 'kosh', 'news', 'ardas', 'requests'] });           // Edmonton, day, ਪੰਜਾਬੀ
  token('B', { uid: 'u9', lang: 'en', tz: 'Asia/Kolkata', when: 'night', topics: ['vyakhya', 'kosh', 'mukhwak', 'news'] });
  token('C', { tz: 'Asia/Kolkata', topics: ['vyakhya'] });                                                // Kolkata, day
  token('D', { lang: 'en', tz: 'Europe/London', when: 'any', topics: ['vyakhya', 'news'] });
  token('E', { topics: ['vyakhya'] });                                                                     // a dead token
  token('F', { uid: 'u3', topics: ['ardas'] });
  token('G', { uid: 'u2', topics: ['team'] });
  token('H', { uid: 'u7', platform: 'android-app', topics: ['mukhwak'] });
  fcm.bad.add('E');
  const t1 = T0 + 15 * MIN;
  await go(t1);
  assert.deepEqual([...fcm.subs.get(`sl_vyakhya_pa_${ED_DAY}`)], ['A']);
  assert.deepEqual([...fcm.subs.get(`sl_vyakhya_en_${KO_NIGHT}`)], ['B']);
  assert.deepEqual([...fcm.subs.get(`sl_vyakhya_pa_${KO_DAY}`)], ['C']);
  assert.deepEqual([...fcm.subs.get('sl_vyakhya_en_any')], ['D']);
  assert.ok(!fcm.subs.get('sl_ardas_pa_' + ED_DAY), 'personal topics are not subscribed');
  assert.equal(db.data('pushTokens/A').dirty, false);
  assert.equal(db.data('pushTokens/E'), undefined, 'a dead token is forgotten');
  assert.equal(Object.keys(db.data('pushState/main').zones).length, 4, 'Edmonton day, Kolkata night, Kolkata day, any time');

  // ── a volunteer adds a vyakhya and a word, and keeps fixing the vyakhya ──
  const t2 = T0 + 20 * MIN;
  db.put('interpretations/G-100', { ang: 12, verseId: 100, scope: 'verse', status: 'approved', currentVersion: 1, createdBy: 'u2', lastEditedAt: t2, verseGurmukhi: 'ਸੋ ਪੁਰਖੁ ਨਿਰੰਜਨੁ ਹਰਿ ਪੁਰਖੁ ਨਿਰੰਜਨੁ ॥' });
  db.put('notifications/n1', { type: 'new', interpretationId: 'G-100', ang: 12, verseId: 100, actorUid: 'u2', createdAt: t2 });
  db.put('definitions/ਕਰਤਾ', { word: 'ਕਰਤਾ', status: 'approved', currentVersion: 1, punjabi: 'ਰਚਨਹਾਰ', english: 'the Creator', lastEditedAt: t2 });
  db.put('notifications/n2', { type: 'new', interpretationId: 'definitions/ਕਰਤਾ', word: 'ਕਰਤਾ', ang: 0, verseId: 0, createdAt: t2 + 1 });
  db.put('angRequests/12', { ang: 12, requesters: ['u1'] });
  // A comment by someone else → the writer (u2) hears; a 'draft' entry is never announced.
  db.put('notifications/n3', { type: 'commented', interpretationId: 'G-100', ang: 12, verseId: 100, actorUid: 'u5', actorName: 'Harpreet', summary: 'commented on Ang 12 interpretation: "ਬਹੁਤ ਸੋਹਣਾ"', createdAt: t2 + 2 });
  db.put('interpretations/G-101', { ang: 12, verseId: 101, status: 'draft', currentVersion: 1, createdBy: 'u2', lastEditedAt: t2 });
  db.put('notifications/n4', { type: 'new', interpretationId: 'G-101', ang: 12, verseId: 101, createdAt: t2 + 3 });
  fcm.clear();
  await go(T0 + 30 * MIN);
  assert.equal(fcm.to(`sl_vyakhya_pa_${ED_DAY}`).length, 0, 'not quiet for an hour yet');
  assert.match(fcm.to('G')[0].title, /Harpreet/);
  assert.equal(fcm.to('G')[0].url, '/#/read/12/100');

  // Fixed again 40 minutes later: the hour starts over.
  const t3 = T0 + 60 * MIN;
  db.put('interpretations/G-100', { ...db.data('interpretations/G-100'), currentVersion: 2, lastEditedAt: t3 });
  db.put('notifications/n5', { type: 'edited', interpretationId: 'G-100', ang: 12, verseId: 100, createdAt: t3 });
  fcm.clear();
  await go(T0 + 100 * MIN);
  assert.equal(fcm.to(`sl_vyakhya_pa_${ED_DAY}`).length, 0, 'edited 40 min ago — still waiting');
  assert.equal(fcm.to(`sl_kosh_pa_${ED_DAY}`).length, 1, 'the word was quiet for over an hour');

  // ── an hour after the last fix: one notification per zone that is in its hours ──
  fcm.clear();
  const t4 = T0 + 125 * MIN;    // Edmonton 14:05 · Kolkata 01:35
  await go(t4);
  const ed = fcm.to(`sl_vyakhya_pa_${ED_DAY}`);
  assert.equal(ed.length, 1);
  assert.match(ed[0].title, /ਨਵੀਂ ਵਿਆਖਿਆ · ਅੰਗ 12/);
  assert.equal(ed[0].url, '/#/read/12/100');
  assert.equal(fcm.to(`sl_vyakhya_en_${KO_NIGHT}`).length, 1, 'night owls in Kolkata get it now');
  assert.equal(fcm.to(`sl_vyakhya_pa_${KO_DAY}`).length, 0, 'Kolkata day people: not at 1:35 am');
  assert.equal(fcm.to('sl_vyakhya_en_any').length, 1);
  assert.match(fcm.to('A').find((m) => m.kind === 'requests')?.body ?? '', /ਅੰਗ 12/, 'the requester hears');
  assert.ok(!fcm.sent.some((m) => m.webpush.data.url?.includes('/101')), 'the draft is never announced');

  // ── edited again: "updated", but not before 4 hours since the last one ──
  const t5 = t4 + 30 * MIN;
  db.put('interpretations/G-100', { ...db.data('interpretations/G-100'), currentVersion: 3, lastEditedAt: t5 });
  db.put('notifications/n6', { type: 'edited', interpretationId: 'G-100', ang: 12, verseId: 100, createdAt: t5 });
  fcm.clear();
  await go(t5 + 65 * MIN);
  assert.equal(fcm.to(`sl_vyakhya_pa_${ED_DAY}`).length, 0, 'within 4 hours of the last');
  fcm.clear();
  await go(t4 + 4 * H + 5 * MIN);   // Edmonton 18:10
  const upd = fcm.to(`sl_vyakhya_pa_${ED_DAY}`);
  assert.equal(upd.length, 1);
  assert.match(upd[0].title, /ਸੋਧੀ ਹੋਈ ਵਿਆਖਿਆ/);
  // Same version again (e.g. only machine translations added): nothing new.
  db.put('notifications/n7', { type: 'status', interpretationId: 'G-100', ang: 12, verseId: 100, actorUid: 'u2', createdAt: t4 + 4 * H + 6 * MIN });
  // ── … and Kolkata's morning (10:35): the day people get the night's news, gathered ──
  fcm.clear();
  await go(t4 + 9 * H);
  assert.equal(fcm.to(`sl_vyakhya_pa_${ED_DAY}`).length, 0, 'version 3 was already announced');
  const ko = fcm.to(`sl_vyakhya_pa_${KO_DAY}`);
  assert.equal(ko.length, 1);
  assert.match(ko[0].title, /ਅੰਗ 12/);
  assert.equal(fcm.to(`sl_kosh_pa_${KO_DAY}`).length, 0, 'C chose vyakhya only');
});

test('the Sangat, MukhWak and an Admin’s news', async () => {
  const { db, fcm, go, token, setMukhwak } = world();
  await go(T0);
  token('A', { uid: 'u1', topics: ['ardas', 'news', 'mukhwak'] });
  token('F', { uid: 'u3', lang: 'en', topics: ['ardas'] });
  token('M', { uid: 'mod', topics: ['team'] });
  token('H', { uid: 'u7', platform: 'android-app', topics: ['mukhwak'] });
  token('K', { tz: 'Asia/Kolkata', topics: ['mukhwak'] });
  await go(T0 + 5 * MIN);

  // u1's Ardas: u3 replies, two say ੴ ਸਤਿਨਾਮ (one is u1 themself), u1 answers u3.
  const t = T0 + 10 * MIN;
  db.put('ardas/a1', { text: 'ਸਰਬੱਤ ਦਾ ਭਲਾ', hidden: false, at: T0 - H });
  db.put('ardasOwners/a1', { uid: 'u1' });
  db.put('ardas/a1/replies/r1', { text: 'Waheguru mehar kare', name: 'Jas', anon: false, hidden: false, at: t });
  db.put('ardasOwners/a1_r1', { uid: 'u3' });
  db.put('ardas/a1/satnaam/u4', { at: t + 1 });
  db.put('ardas/a1/satnaam/u1', { at: t + 2 });
  db.put('ardas/a1/replies/r2', { text: 'Thank you ji', name: '', anon: true, hidden: false, at: t + 3, replyTo: { id: 'r1', name: 'Jas' } });
  db.put('ardasOwners/a1_r2', { uid: 'u1' });
  db.put('ardasReports/x1', { ardasId: 'a1', replyId: '', why: 'spam', at: t + 4, done: false });
  db.put('members/mod', { role: 4, status: 'active' });
  // An Admin's news for everyone, and the Android app update.
  db.put('pushOutbox/o1', { title: '📢 New feature', body: 'Notifications!', url: '/#/mukhwak', audience: 'all', at: t, done: false });
  db.put('pushOutbox/o2', { title: '📱 New SevaLekh app 1.0.4', body: 'Open the app to update.', titlePa: '📱 ਸੇਵਾਲੇਖ ਐਪ 1.0.4', bodyPa: 'ਅੱਪਡੇਟ ਕਰੋ', url: '/', audience: 'android-app', at: t, done: false });
  // Tomorrow's MukhWak is out (India's morning = Edmonton's evening before).
  setMukhwak({ date: '2026-10-13', ang: 610, made: new Date(t).toISOString() });
  fcm.clear();
  await go(T0 + 20 * MIN);

  const owner = fcm.to('A').find((m) => m.kind === 'ardas');
  assert.ok(owner, 'the writer hears');
  assert.match(owner.body, /1 ਵਾਰ ੴ ਸਤਿਨਾਮ · 1 ਜਵਾਬ — Jas/);
  assert.equal(owner.url, '/#/ardas/a1');
  const toU3 = fcm.to('F');
  assert.equal(toU3.length, 1);
  assert.match(toU3[0].body, /a member of the Sangat: Thank you ji/, 'the anonymous reply stays anonymous');
  assert.match(fcm.to('M')[0].title, /ਰਿਪੋਰਟ/);
  assert.equal(db.data('pushOutbox/o2').done, true);
  assert.equal(fcm.to('H')[0].title, '📱 ਸੇਵਾਲੇਖ ਐਪ 1.0.4');
  const news = fcm.to(`sl_news_pa_${ED_DAY}`);
  assert.equal(news[0].title, '📢 New feature', 'no Punjabi version: English for everyone');
  assert.equal(news[0].url, '/#/mukhwak');
  const mk = fcm.to(`sl_mukhwak_pa_${ED_DAY}`);
  assert.equal(mk.length, 1);
  assert.match(mk[0].title, /ਅੰਗ 610/);
  assert.equal(mk[0].body, 'ਗੁਰਿ ਪੂਰੈ ਕਿਰਪਾ ਧਾਰੀ ॥', 'the first line, not the heading');
  assert.equal(fcm.to(`sl_mukhwak_pa_${KO_DAY}`).length, 0, 'Kolkata: it is night there');

  // Remade later (edited meanings): same date, no second MukhWak.
  setMukhwak({ date: '2026-10-13', ang: 610, made: new Date(T0 + H).toISOString() });
  fcm.clear();
  await go(T0 + 75 * MIN);
  assert.equal(fcm.to(`sl_mukhwak_pa_${ED_DAY}`).length, 0);
  // Kolkata wakes up: their MukhWak.
  fcm.clear();
  await go(T0 + 9 * H + 30 * MIN);
  assert.equal(fcm.to(`sl_mukhwak_pa_${KO_DAY}`).length, 1);
});

test('turning off forgets the device and its topics', async () => {
  const { db, fcm, go, token } = world();
  await go(T0);
  token('A', { topics: ['vyakhya', 'news'] });
  await go(T0 + 15 * MIN);
  assert.ok(fcm.subs.get(`sl_news_pa_${ED_DAY}`).has('A'));
  token('A', { topics: [] });
  await go(T0 + 30 * MIN);
  assert.ok(!fcm.subs.get(`sl_news_pa_${ED_DAY}`).has('A'));
  assert.equal(db.data('pushTokens/A'), undefined);
  assert.equal(db.data('pushSubs/A'), undefined);
  // Switching language or hours moves the subscription.
  token('B', { topics: ['news'] });
  await go(T0 + 45 * MIN);
  token('B', { topics: ['news'], lang: 'en', when: 'night' });
  await go(T0 + 60 * MIN);
  assert.ok(!fcm.subs.get(`sl_news_pa_${ED_DAY}`).has('B'));
  assert.ok(fcm.subs.get(`sl_news_en_${zoneId('America/Edmonton', 'night')}`).has('B'));
});

test('a quiet run reads little', async () => {
  const { db, go } = world();
  await go(T0);
  db.reads = 0;
  await go(T0 + 15 * MIN);
  assert.ok(db.reads <= 15, `reads: ${db.reads}`);
});

test('texts', () => {
  const two = TEXT.vyakhya([{ ang: 5, verseId: 1, line: 'x' }, { ang: 7, verseId: 2, line: 'y', edited: true }], 'en');
  assert.equal(two.title, '📝 Vyakhya: 1 new, 1 updated · Angs 5, 7');
  assert.equal(two.body, 'Ang 5 — x\nAng 7 — y');
  const words = TEXT.kosh([{ word: 'ਹਰਿ', pa: 'ਪ੍ਰਭੂ', en: 'God' }, { word: 'ਨਾਮੁ', pa: 'ਨਾਮ', en: 'the Name', edited: true }], 'pa');
  assert.equal(words.title, '📚 ਸ਼ਬਦਕੋਸ਼: 1 ਨਵਾਂ, 1 ਸੋਧਿਆ — ਹਰਿ, ਨਾਮੁ');
  assert.equal(words.body, 'ਹਰਿ — ਪ੍ਰਭੂ\nਨਾਮੁ — ਨਾਮ');
  assert.equal(TEXT.kosh([{ word: 'ਹਰਿ', pa: 'ਪ੍ਰਭੂ', en: 'God' }], 'en').title, '📚 New in the dictionary: ਹਰਿ');
});
