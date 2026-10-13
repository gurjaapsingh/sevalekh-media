/**
 * A tiny in-memory stand-in for firebase-admin's Firestore and Messaging —
 * only what push.mjs uses — so `npm test` checks the robot with no network.
 */
let clock = 0;
const tick = () => ({ n: ++clock, isEqual(o) { return o?.n === this.n; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

class Snap {
  constructor(ref, rec) { this.ref = ref; this.id = ref.id; this.exists = !!rec; this._d = rec ? clone(rec.data) : undefined; this.updateTime = rec?.time; }
  data() { return this._d; }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  get parent() { return new CollRef(this.db, this.path.split('/').slice(0, -1).join('/')); }
  async get() { return new Snap(this, this.db.store.get(this.path)); }
  _check(pre) {
    const rec = this.db.store.get(this.path);
    if (pre?.lastUpdateTime && !(rec && pre.lastUpdateTime.isEqual(rec.time))) throw new Error('FAILED_PRECONDITION');
  }
  async set(data, opts) {
    const rec = this.db.store.get(this.path);
    const d = opts?.merge && rec ? { ...rec.data, ...clone(data) } : clone(data);
    this.db.store.set(this.path, { data: d, time: tick() });
  }
  async update(data, pre) {
    this._check(pre);
    const rec = this.db.store.get(this.path);
    if (!rec) throw new Error('NOT_FOUND');
    this.db.store.set(this.path, { data: { ...rec.data, ...clone(data) }, time: tick() });
  }
  async delete(pre) { this._check(pre); this.db.store.delete(this.path); }
  collection(name) { return new CollRef(this.db, `${this.path}/${name}`); }
}

class Query {
  constructor(db, test, filters = [], order = null, lim = Infinity) { Object.assign(this, { db, test, filters, order, lim }); }
  where(f, op, v) { return new Query(this.db, this.test, [...this.filters, { f, op, v }], this.order, this.lim); }
  orderBy(f) { return new Query(this.db, this.test, this.filters, f, this.lim); }
  limit(n) { return new Query(this.db, this.test, this.filters, this.order, n); }
  async get() {
    this.db.reads++;
    let rows = [...this.db.store.entries()].filter(([p]) => this.test(p)).map(([p, rec]) => ({ p, rec }));
    rows = rows.filter(({ rec }) => this.filters.every(({ f, op, v }) => {
      const x = get(rec.data, f);
      switch (op) {
        case '==': return x === v || (v === null && x === null);
        case '>': return x !== undefined && x > v;
        case '<': return x !== undefined && x < v;
        case 'in': return v.includes(x);
        case 'array-contains': return Array.isArray(x) && x.includes(v);
        default: throw new Error(`op ${op}`);
      }
    }));
    if (this.order) rows.sort((a, b) => get(a.rec.data, this.order) - get(b.rec.data, this.order));
    rows = rows.slice(0, this.lim);
    const docs = rows.map(({ p, rec }) => new Snap(new DocRef(this.db, p), rec));
    return { docs, empty: !docs.length, size: docs.length };
  }
}

class CollRef extends Query {
  constructor(db, path) {
    const depth = path.split('/').length;
    super(db, (p) => p.startsWith(`${path}/`) && p.split('/').length === depth + 1);
    this.path = path; this.id = path.split('/').pop();
  }
  get parent() { const parts = this.path.split('/'); return parts.length > 1 ? new DocRef(this.db, parts.slice(0, -1).join('/')) : null; }
  doc(id) { return new DocRef(this.db, `${this.path}/${id}`); }
}

export class FakeDb {
  constructor() { this.store = new Map(); this.reads = 0; }
  doc(path) { return new DocRef(this, path); }
  collection(path) { return new CollRef(this, path); }
  collectionGroup(name) {
    return new Query(this, (p) => { const s = p.split('/'); return s.length >= 2 && s[s.length - 2] === name; });
  }
  async getAll(...refs) { this.reads += refs.length; return Promise.all(refs.map((r) => r.get())); }
  batch() {
    const ops = [];
    return {
      set: (ref, d, o) => ops.push(() => ref.set(d, o)),
      update: (ref, d) => ops.push(() => ref.update(d)),
      delete: (ref) => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); },
    };
  }
  /** Test helper: put a document. */
  put(path, data) { this.store.set(path, { data: clone(data), time: tick() }); }
  data(path) { return clone(this.store.get(path)?.data); }
}

export class FakeMessaging {
  constructor() { this.sent = []; this.subs = new Map(); this.bad = new Set(); }
  async send(m) { this.sent.push(m); return 'id'; }
  async sendEach(ms) {
    return {
      responses: ms.map((m) => {
        if (this.bad.has(m.token)) return { success: false, error: { code: 'messaging/registration-token-not-registered' } };
        this.sent.push(m);
        return { success: true };
      }),
    };
  }
  async subscribeToTopic(toks, topic) {
    const errors = [];
    toks.forEach((t, index) => {
      if (this.bad.has(t)) errors.push({ index, error: { code: 'messaging/invalid-registration-token' } });
      else (this.subs.get(topic) ?? this.subs.set(topic, new Set()).get(topic)).add(t);
    });
    return { successCount: toks.length - errors.length, failureCount: errors.length, errors };
  }
  async unsubscribeFromTopic(toks, topic) { for (const t of toks) this.subs.get(topic)?.delete(t); return { errors: [] }; }
  /** Test helper: titles sent to a topic / a token. */
  to(target) { return this.sent.filter((m) => m.topic === target || m.token === target).map((m) => m.webpush.data); }
  clear() { this.sent = []; }
}
