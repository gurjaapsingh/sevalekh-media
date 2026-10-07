/**
 * Tests for karaoke-video.mjs, on the mock alignment in samples/karaoke/ (the first six lines of Ang 1, in the
 * format tools/paath-align/align.py writes) and a synthetic recording with a beep at every word start.
 *
 *   node --test test-karaoke.mjs          (or: npm run test:karaoke)
 *
 * The render tests run the real command line and check the MP4 itself: size, audio against the source,
 * subtitle colours and the moment each word lights up. They leave the demo at out/karaoke-demo.mp4.
 * Needs ffmpeg/ffprobe, and a font with Gurmukhi (Noto Sans Gurmukhi, else FreeSans; else those tests skip).
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from './karaoke-video.mjs';
import { makeMockRecording, MOCK_RATE } from './samples/karaoke/make-mock-audio.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ALIGN_DIR = path.join(ROOT, 'samples', 'karaoke', 'alignment');
const TEXT = path.join(ROOT, 'samples', 'karaoke', 'text.json');
const OUT = path.join(ROOT, 'out');
const CLI = path.join(ROOT, 'karaoke-video.mjs');

const sh = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 1 << 28, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout.toString(); err.stderr = stderr.toString(); reject(err); } else resolve(stdout);
  });
});
const cli = (args) => sh('node', [CLI, ...args]);
const cs = (s) => Math.round(s * 100);

/** The font to draw with here: Noto Sans Gurmukhi if installed, else FreeSans, else null. */
async function fontArgs() {
  const has = async (q) => (await sh('fc-list', [q, 'file']).catch(() => Buffer.alloc(0))).toString().trim();
  if (await has('Noto Sans Gurmukhi')) return [];
  const free = '/usr/share/fonts/truetype/freefont';
  if (await fs.stat(path.join(free, 'FreeSans.ttf')).then(() => true, () => false)) return ['--font', 'FreeSans', '--fonts-dir', free];
  return null;
}
const FONT = await fontArgs();

const alignment = JSON.parse(await fs.readFile(path.join(ALIGN_DIR, '1.json'), 'utf8'));
const allWords = alignment.lines.flatMap((l) => l[4]);
const allLines = async (range) => {
  const lines = K.selectLines(await K.loadAlignment(ALIGN_DIR), range && K.parseRange(range));
  return K.attachText(lines, { textFile: TEXT });
};

const parseTime = (s) => { const [h, m, sec] = s.split(':'); return cs(Number(h) * 3600 + Number(m) * 60 + Number(sec)); };
/** The Dialogue lines of an .ass: shown from/to (cs) and the {\k} durations (cs) in order. */
const parseEvents = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => {
  const m = l.match(/^Dialogue: 0,([^,]+),([^,]+),Gurbani,,0,0,0,,(.*)$/);
  assert.ok(m, `unexpected Dialogue line: ${l}`);
  return { from: parseTime(m[1]), to: parseTime(m[2]), ks: [...m[3].matchAll(/\{\\k(\d+)\}/g)].map((x) => Number(x[1])), text: m[3] };
});

// ── Pure functions ──────────────────────────────────────────────────────────
describe('verse selection', () => {
  test('parseRange', () => {
    assert.deepEqual(K.parseRange('7'), { from: 7, to: 7 });
    assert.deepEqual(K.parseRange(' 5 - 9 '), { from: 5, to: 9 });
    assert.throws(() => K.parseRange('9-5'), /backwards/);
    assert.throws(() => K.parseRange('a-b'), /not a number/);
  });

  test('selectLines: the range, in order, from a file in align.py\'s format', async () => {
    const sel = K.selectLines(await K.loadAlignment(path.join(ALIGN_DIR, '1.json')), K.parseRange('3-5'));
    assert.deepEqual(sel.map((l) => l.verseId), [3, 4, 5]);
    assert.equal(sel[0].stem, 'Ang-0001-0013');
    assert.equal(sel[0].words.length, 4);
    assert.throws(() => K.selectLines(sel, K.parseRange('99-100')), /No line/);
  });

  test('a reciter folder is scanned; --ang narrows it', async () => {
    assert.equal((await K.loadAlignment(ALIGN_DIR)).length, 6);
    assert.equal((await K.loadAlignment(ALIGN_DIR, { angs: new Set([2]) })).length, 0);
  });

  test('verses from two recordings are refused', () => {
    const mk = (verseId, stem) => ({ verseId, stem, ang: 1, start: 1, end: 2, words: [1] });
    assert.throws(() => K.selectLines([mk(1, 'a'), mk(2, 'b')]), /2 different recordings \(a, b\)/);
  });
});

describe('text → syllables', () => {
  test('॥ markers ride on the neighbouring word and take no time', () => {
    assert.deepEqual(K.splitSyllables('॥ ਜਪੁ ॥', 1), ['॥ ਜਪੁ ॥']);
    assert.equal(K.splitSyllables('ਹੈ ਭੀ ਸਚੁ ਨਾਨਕ ਹੋਸੀ ਭੀ ਸਚੁ ॥੧॥', 7).at(-1), 'ਸਚੁ ॥੧॥');
  });
  test('ੴ and a lone numeral are words, as align.py counts them', () => {
    assert.equal(K.splitSyllables('ੴ ਸਤਿ ਨਾਮੁ', 3)[0], 'ੴ');
    assert.equal(K.splitSyllables('ਮਹਲਾ ੧ ॥', 2).length, 2);
  });
  test('the wrong text for the timings is an error naming the verse', () => {
    assert.throws(() => K.splitSyllables('ਆਦਿ ਸਚੁ', 4, 3), /Verse 3: 2 words in the text but 4 word timings/);
  });
});

describe('slice and subtitles', () => {
  test('planSlice: pads, never before 0 or past the recording', async () => {
    const lines = await allLines('3-6');
    const s = K.planSlice(lines);
    assert.deepEqual([s.start, s.end], [14.98, 32.45]);
    assert.equal(K.planSlice(await allLines('1-1')).start, 0.95);
    assert.equal(K.planSlice(await allLines('1-1'), { padStart: 5 }).start, 0);
    assert.equal(K.planSlice(lines, { audioSeconds: 32.3 }).end, 32.3);
    assert.throws(() => K.planSlice(lines, { audioSeconds: 20 }), /right file/);
  });

  test('style: white words fill to gold (libass fills Secondary → Primary)', async () => {
    const lines = await allLines('1-1');
    const ass = K.buildAss(lines, K.planSlice(lines));
    const style = ass.split('\n').find((l) => l.startsWith('Style:')).split(',');
    assert.equal(style[3], '&H0000D7FF&', 'PrimaryColour = gold, what a sung word becomes');
    assert.equal(style[4], '&H00FFFFFF&', 'SecondaryColour = white, what it is until then');
    assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
    assert.equal(K.assColor('FFD700'), '&H0000D7FF&');
  });

  test('every word starts at its time, rebased so the slice starts at t = 0', async () => {
    for (const range of ['1-6', '3-6', '4-4']) {
      const lines = await allLines(range);
      const slice = K.planSlice(lines);
      const events = parseEvents(K.buildAss(lines, slice));
      assert.equal(events.length, lines.length);
      assert.equal(events[0].from, 0, 'the first line is up from the first frame');
      let prevTo = 0;
      events.forEach((e, i) => {
        const l = lines[i];
        assert.equal(e.ks.length, l.words.length + 1, 'a lead-in, then one per word');
        let at = e.from + e.ks[0];                                   // where the first word starts
        l.words.forEach((w, j) => {
          assert.equal(at, cs(w) - slice.startCs, `${range}: verse ${l.verseId} word ${j}`);
          at += e.ks[j + 1];                                         // next word starts when this one ends
        });
        assert.equal(at, cs(l.end) - slice.startCs, `verse ${l.verseId}: the last word ends with the line`);
        assert.ok(e.from >= prevTo, `verse ${l.verseId} doesn't overlap the one before`);
        assert.ok(e.to >= at, `verse ${l.verseId} stays up to the end of its last word`);
        prevTo = e.to;
      });
      assert.ok(prevTo <= slice.endCs - slice.startCs, 'nothing is shown past the clip');
    }
  });

  test('odd times round once, so the durations add up exactly (no drift)', () => {
    const line = { verseId: 9, ang: 1, stem: 's', start: 1.004, end: 2.0149, words: [1.004, 1.2349, 1.4951, 1.7777], text: 'ਕ ਖ ਗ ਘ ॥' };
    const slice = K.planSlice([line]);
    const [e] = parseEvents(K.buildAss([line], slice));
    assert.equal(e.ks.slice(1).reduce((a, b) => a + b, 0), cs(2.0149) - cs(1.004));
  });
});

describe('Gurmukhi text for lines that have none', () => {
  let server, url, tmp;
  const requests = [];
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-bani-'));
    const text = JSON.parse(await fs.readFile(TEXT, 'utf8'));
    // BaniDB's /angs/<n>/G, in the shape tools/paath-align/align.py reads: {page: [{verseId, shabadId, verse: {unicode}}]}
    const page = Object.entries(text).map(([id, unicode]) => ({ verseId: Number(id), shabadId: 1, verse: { unicode } }));
    server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url === '/v2/angs/1/G') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ page })); } else { res.statusCode = 500; res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}/v2`;
  });
  after(async () => { server.close(); await fs.rm(tmp, { recursive: true, force: true }); });

  const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

  test('fetched from BaniDB once, then read from the cache', async () => {
    const cache = path.join(tmp, 'ang'), ass = path.join(tmp, 'a.ass');
    const args = ['--align', ALIGN_DIR, '--verses', '2-3', '--ass-only', '--ass', ass, '--cache-dir', cache];
    await quiet(() => K.main([...args, '--banidb-url', url]));
    assert.match(await fs.readFile(ass, 'utf8'), /ਆਦਿ.*ਸਚੁ.*ਜੁਗਾਦਿ/);
    const cached = JSON.parse(await fs.readFile(path.join(cache, '1.json'), 'utf8'));
    assert.deepEqual(Object.keys(cached[0]).sort(), ['gurmukhi', 'roman', 'shabadId', 'verseId'], 'the cache align.py and paath-import share');
    assert.equal(cached.find((v) => v.verseId === 3).gurmukhi, 'ਆਦਿ ਸਚੁ ਜੁਗਾਦਿ ਸਚੁ ॥');
    const seen = requests.length;
    await quiet(() => K.main([...args, '--banidb-url', 'http://127.0.0.1:1/v2']));   // nothing listens there: the cache answers
    assert.equal(requests.length, seen);
  });

  test('--text beats the network', async () => {
    const seen = requests.length;
    const lines = await K.attachText(await K.loadAlignment(ALIGN_DIR), { textFile: TEXT, cacheDir: path.join(tmp, 'none'), baniUrl: url });
    assert.equal(lines.length, 6);
    assert.equal(requests.length, seen);
  });

  test('an unreachable BaniDB says how to give the text instead', async () => {
    await assert.rejects(
      K.attachText(await K.loadAlignment(ALIGN_DIR), { cacheDir: path.join(tmp, 'x'), baniUrl: `${url}/missing` }),
      /No Gurmukhi for Ang 1: BaniDB: HTTP 500.*--text/,
    );
  });
});

describe('command line', () => {
  test('--help', async () => assert.match((await cli(['--help'])).toString(), /--verses/));
  test('missing options and a recording-spanning range fail with a message and exit code 1', async () => {
    await assert.rejects(cli([]), (e) => e.code === 1 && /--align, --audio and --out are needed/.test(e.stderr));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-cli-'));
    try {
      const two = { v: 1, ang: 1, lines: [alignment.lines[0], [2, 'Ang-0002-0003', 1, 2, [1]]] };
      await fs.writeFile(path.join(tmp, '1.json'), JSON.stringify(two));
      await assert.rejects(cli(['--align', tmp, '--text', TEXT, '--ass-only', '--ass', path.join(tmp, 'x.ass')]),
        (e) => e.code === 1 && /2 different recordings/.test(e.stderr));
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
});

// ── The MP4 itself ──────────────────────────────────────────────────────────
describe('rendered clip', { skip: FONT === null && 'no font with Gurmukhi installed' }, () => {
  const AUDIO = path.join(OUT, 'mock-audio');
  const DEMO = path.join(OUT, 'karaoke-demo.mp4');
  let recording, tmp, slice;

  /** Beep starts in a recording or clip (s): where the loudness comes up after ≥ 100 ms of quiet. */
  async function onsets(file) {
    const buf = await sh('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(MOCK_RATE), '-f', 's16le', '-']);
    const x = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const win = Math.round(MOCK_RATE * 0.005), thr = 0.15 * 32767, found = [];
    let quiet = 99;
    for (let w = 0; w * win < x.length; w++) {
      let first = -1;
      for (let i = w * win; i < Math.min(x.length, (w + 1) * win); i++) if (Math.abs(x[i]) >= thr) { first = i; break; }
      if (first < 0) quiet++;
      else { if (quiet >= 20) found.push(first / MOCK_RATE); quiet = 0; }
    }
    return found;
  }

  /** Pixels of the subtitle colours in the clip's frame at t, and the colour of the corners. */
  async function frame(file, t) {
    const buf = await sh('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', 'scale=in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.equal(buf.length, 1080 * 1920 * 3);
    let gold = 0, white = 0;
    for (let i = 0; i < buf.length; i += 3) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      if (r > 200 && g > 150 && g < 235 && b < 110) gold++;
      else if (r > 225 && g > 225 && b > 225) white++;
    }
    const px = (x, y) => [...buf.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)];
    return { gold, white, topLeft: px(0, 0), bottomRight: px(1079, 1919) };
  }
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-test-'));
    recording = await makeMockRecording(path.join(ALIGN_DIR, '1.json'), AUDIO);
    slice = K.planSlice(await allLines('1-6'));
    // the command line from the README
    await cli(['--align', ALIGN_DIR, '--audio', AUDIO, '--text', TEXT, '--verses', '1-6',
      '--out', DEMO, '--ass', path.join(OUT, 'karaoke-demo.ass'), ...FONT]);
  });
  after(() => fs.rm(tmp, { recursive: true, force: true }));

  test('1080×1920 H.264 + AAC, as long as the slice', async () => {
    const j = JSON.parse(await sh('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', DEMO]));
    const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
    assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt], ['h264', 1080, 1920, 'yuv420p']);
    assert.equal(v.color_space, 'bt709');
    assert.equal(a.codec_name, 'aac');
    assert.ok(Math.abs(Number(j.format.duration) - slice.duration) < 0.05, `duration ${j.format.duration} vs ${slice.duration}`);
    const enc = (await sh('ffprobe', ['-v', 'error', '-show_entries', 'stream_tags=encoder', '-of', 'default=nw=1:nk=1', DEMO])).toString();
    assert.match(enc, /libx264/);
  });

  test('the audio is the recording from the slice start (beeps line up with the source)', async () => {
    const src = await onsets(recording), out = await onsets(DEMO);
    assert.equal(src.length, allWords.length, 'one beep per word in the recording');
    src.forEach((t, i) => assert.ok(Math.abs(t - allWords[i]) < 0.04, `source beep ${i}: ${t} vs word at ${allWords[i]}`));
    assert.equal(out.length, src.length, 'every beep is in the clip');
    out.forEach((t, i) => assert.ok(Math.abs(t - (src[i] - slice.start)) < 0.03, `clip beep ${i}: ${t} vs ${src[i] - slice.start}`));
  });

  test('words are white until recited, then gold', async () => {
    const pre = await frame(DEMO, 0.1);          // line 1 is up, its first word starts at 0.25
    assert.equal(pre.gold, 0);
    assert.ok(pre.white > 3000, `white pixels: ${pre.white}`);
    const during = await frame(DEMO, 2.6);          // the third word has just begun (2.41)
    assert.ok(during.gold > 3000 && during.white > 3000, `gold ${during.gold}, white ${during.white}`);
    const post = await frame(DEMO, 12.2);          // the whole line is recited, still held
    assert.ok(post.gold > 3000 && post.white < 30, `gold ${post.gold}, white ${post.white}`);
  });

  test('each word lights up at its own time, not before or after (verses 3 and 4)', async () => {
    for (const [verse, words] of alignment.lines.filter((l) => l[0] === 3 || l[0] === 4).map((l) => [l[0], l[4]])) {
      for (const [j, w] of words.entries()) {
        const t = w - slice.start;
        const [early, late] = [await frame(DEMO, t - 0.06), await frame(DEMO, t + 0.06)];
        assert.ok(late.gold > early.gold + 300, `verse ${verse} word ${j} (at ${t.toFixed(2)} s): gold ${early.gold} → ${late.gold}`);
      }
    }
  });

  test('the gradient plate runs from the top colour to the bottom colour', async () => {
    const f = await frame(DEMO, 0.1);
    assert.ok(near(f.topLeft, [0x1B, 0x1F, 0x3B], 4), `top ${f.topLeft}`);
    assert.ok(near(f.bottomRight, [0x07, 0x08, 0x0F], 4), `bottom ${f.bottomRight}`);
  });

  test('--bg solid, a range of one verse, and the cut on a different start (--accurate-seek)', async () => {
    const solid = path.join(tmp, 'solid.mp4');
    await cli(['--align', ALIGN_DIR, '--audio', AUDIO, '--text', TEXT, '--verses', '3', '--bg', 'solid', '--bg-color', '102030',
      '--accurate-seek', '--out', solid, ...FONT]);
    const f = await frame(solid, 0.1);
    assert.ok(near(f.topLeft, [0x10, 0x20, 0x30], 4) && near(f.bottomRight, [0x10, 0x20, 0x30], 4), `${f.topLeft} ${f.bottomRight}`);
    // verse 3 only: the clip starts 0.25 s before its first word, and so do the beep and the subtitles
    const s3 = K.planSlice(await allLines('3'));
    const beeps = await onsets(solid), src = await onsets(recording);
    assert.equal(beeps.length, 4);
    beeps.forEach((t, i) => assert.ok(Math.abs(t - (src[14 + i] - s3.start)) < 0.03, `beep ${i}: ${t}`));
    const [early, late] = [await frame(solid, 0.25 - 0.06), await frame(solid, 0.25 + 0.06)];
    assert.ok(late.gold > early.gold + 300, `the first word lights at 0.25 s even with --accurate-seek: ${early.gold} → ${late.gold}`);
  });

  test('a fonts folder with quotes, colons, commas and spaces in its name', async () => {
    const odd = path.join(tmp, "it's: a,b [fonts]");
    await fs.mkdir(odd);
    const out = path.join(tmp, 'odd.mp4');
    await cli(['--align', ALIGN_DIR, '--audio', AUDIO, '--text', TEXT, '--verses', '2', '--fonts-dir', odd, '--out', out]);
    assert.ok((await fs.stat(out)).size > 1000);
  });
});
