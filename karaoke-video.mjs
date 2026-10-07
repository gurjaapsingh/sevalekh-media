#!/usr/bin/env node
/**
 * 🎤 Karaoke clips — a few lines of Gurbani, recited, with the word being said lit up.
 *
 *   node karaoke-video.mjs --align <Ang file | reciter folder> --audio <recording | folder> \
 *        --verses 1-6 --out out/clip.mp4
 *
 * Reads the timing files tools/paath-align/align.py writes (SevaLekh's public/paath/<reciter>/<ang>.json):
 *
 *   {"v":1,"ang":1,"lines":[[verseId, "<recording>", lineStart, lineEnd, [wordStart, …]], …]}
 *
 * Times are seconds into that recording. The files carry no text, so the Gurmukhi comes from (first found)
 * a 6th item on the line, a --text file {"<verseId>": "ਗੁਰਮੁਖੀ …"}, the cached Ang pages in --cache-dir
 * (the same .cache/ang SevaLekh's tools fill), or BaniDB itself (then cached there).
 *
 * Steps (each one an exported function, so they can be used or tested on their own):
 *   1. loadAlignment → selectLines   find the lines in the verse range
 *   2. attachText                    their Gurmukhi
 *   3. planSlice                     which part of the recording the clip uses
 *   4. buildAss                      karaoke subtitles, times rebased so the slice starts at t = 0
 *   5. renderClip                    ffmpeg + libass: 1080×1920 plate, slice of the recording, subtitles
 *
 * Needs ffmpeg (with libass and libx264) and ffprobe on PATH, and a font that has Gurmukhi
 * (Noto Sans Gurmukhi: `apt install fonts-noto-core`, or point --fonts-dir at a folder holding it).
 *
 * Colours: libass fills a karaoke word from SecondaryColour to PrimaryColour as it is sung, so the style
 * below has PrimaryColour = gold (the fill) and SecondaryColour = white (the words still to come).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Look ────────────────────────────────────────────────────────────────────
export const VIDEO = { width: 1080, height: 1920, fps: 30 };
export const COLORS = {
  text: 'FFFFFF',     // words not yet recited
  fill: 'FFD700',     // words recited (warm gold) — ASS: &H0000D7FF&
  outline: '000000',
  bgTop: '1B1F3B',    // gradient plate, top → bottom
  bgBottom: '07080F',
};
const STYLE = 'Gurbani';
const REPO_FONTS = fileURLToPath(new URL('./fonts/', import.meta.url));
const DEFAULT_FONT = 'Noto Sans Gurmukhi';
const LEAD_IN = 0.3;   // s a line is shown before its first word, so it can be read ahead
const HOLD = 0.5;      // s a line stays after its last word (never over the next line)
const PAD_START = 0.25; // s of recording before the first word / after the last (App's TAIL is 0.25)
const PAD_END = 0.25;

// ── Alignment files ─────────────────────────────────────────────────────────
/** One entry of an Ang's `lines`: [verseId, recording, start, end, [wordStarts…], text?] */
export function parseLine(entry, ang) {
  if (!Array.isArray(entry) || entry.length < 4) throw new Error(`Ang ${ang}: a line should be [verseId, file, start, end, [wordStarts…]]`);
  const [verseId, stem, start, end, words, text] = entry;
  const line = {
    verseId: Number(verseId), ang, stem: String(stem), start: Number(start), end: Number(end),
    words: Array.isArray(words) ? words.map(Number) : [],
    text: typeof text === 'string' && text.trim() ? text : undefined,
  };
  if (![line.verseId, line.start, line.end, ...line.words].every(Number.isFinite)) throw new Error(`Ang ${ang}, verse ${entry[0]}: a time or id is not a number`);
  return line;
}

/**
 * The lines of one Ang file, or — for a reciter folder — of every <ang>.json in it (only `angs` if given).
 * @returns {Promise<object[]>}
 */
export async function loadAlignment(src, { angs } = {}) {
  const st = await fs.stat(src).catch(() => null);
  if (!st) throw new Error(`Alignment not found: ${src}`);
  const files = st.isDirectory()
    ? (await fs.readdir(src)).filter((f) => /^\d+\.json$/.test(f)).map((f) => path.join(src, f))
    : [src];
  if (!files.length) throw new Error(`No <ang>.json files in ${src}`);
  const out = [];
  for (const f of files) {
    const j = JSON.parse(await fs.readFile(f, 'utf8'));
    const ang = Number(j.ang ?? path.basename(f, '.json'));
    if (angs && !angs.has(ang)) continue;
    if (!Array.isArray(j.lines)) throw new Error(`${f}: no "lines" list`);
    for (const e of j.lines) out.push(parseLine(e, ang));
  }
  return out;
}

/** "7" → {from: 7, to: 7}; "7-12" → {from: 7, to: 12}. Inclusive, by verse id. */
export function parseRange(s) {
  const m = String(s).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) throw new Error(`"${s}" is not a number or a range like 5-9`);
  const from = Number(m[1]), to = Number(m[2] ?? m[1]);
  if (to < from) throw new Error(`Range ${s} runs backwards`);
  return { from, to };
}

/**
 * The lines in the verse range, in recitation order (verse ids run on from Ang to Ang). One slice is cut from
 * one recording, so all must come from the same one.
 */
export function selectLines(lines, range) {
  const sel = lines.filter((l) => !range || (l.verseId >= range.from && l.verseId <= range.to)).sort((a, b) => a.verseId - b.verseId);
  if (!sel.length) throw new Error(range ? `No line with a verse id from ${range.from} to ${range.to} in the alignment` : 'The alignment has no lines');
  const stems = [...new Set(sel.map((l) => l.stem))];
  if (stems.length > 1) {
    throw new Error(`The verses are in ${stems.length} different recordings (${stems.join(', ')}); a clip is cut from one. Choose a narrower --verses range.`);
  }
  for (const l of sel) {
    if (!l.words.length) throw new Error(`Verse ${l.verseId} has no word timings`);
    if (l.end <= l.start) throw new Error(`Verse ${l.verseId}: ends (${l.end}) before it starts (${l.start})`);
  }
  return sel;
}

// ── Text ────────────────────────────────────────────────────────────────────
const BANIDB = 'https://api.banidb.com/v2';

/** The Ang as BaniDB gives it, cached the way tools/paath-align/align.py does: [{verseId, shabadId, gurmukhi, roman}]. */
async function angPage(ang, { cacheDir, baniUrl = BANIDB, log }) {
  const f = path.join(cacheDir, `${ang}.json`);
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { /* fetch */ }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${baniUrl}/angs/${ang}/G`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const lines = (j.page ?? j.verses ?? []).map((v) => ({
        verseId: Number(v.verseId), shabadId: Number(v.shabadId), gurmukhi: String(v.verse?.unicode ?? ''), roman: '',
      }));
      if (!lines.length) throw new Error('no verses in the answer');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(f, JSON.stringify(lines));
      log?.(`BaniDB: Ang ${ang}`);
      return lines;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw new Error(`No Gurmukhi for Ang ${ang}: BaniDB: ${lastErr?.message}. Give the text with --text, or fill ${cacheDir}.`);
}

/** Sets `.text` on every line that has none: --text file, then the cached/fetched Ang page. */
export async function attachText(lines, { textFile, cacheDir = path.resolve('.cache', 'ang'), baniUrl, log } = {}) {
  const side = textFile ? JSON.parse(await fs.readFile(textFile, 'utf8')) : {};
  const pages = new Map();
  for (const l of lines) {
    if (l.text) continue;
    if (typeof side[l.verseId] === 'string') { l.text = side[l.verseId]; continue; }
    if (!pages.has(l.ang)) pages.set(l.ang, await angPage(l.ang, { cacheDir, baniUrl, log }));
    const v = pages.get(l.ang).find((x) => x.verseId === l.verseId);
    if (!v?.gurmukhi) throw new Error(`Verse ${l.verseId} is not on Ang ${l.ang} in BaniDB's text`);
    l.text = v.gurmukhi;
  }
  return lines;
}

// ── Subtitles ───────────────────────────────────────────────────────────────
// The words the timings are for: tools/paath-align/align.py `recited_tokens` and SevaLekh's isRecitedToken —
// a token with a letter in it, or a numeral on its own (੧ is said "ਪਹਿਲਾ"). Markers like ॥ and ॥੧॥ are not counted.
const LETTER = /[\u0A05-\u0A39\u0A59-\u0A5E\u0A72-\u0A74]/;
const NUMERAL = /^[\u0A66-\u0A6F]+$/;
export const isRecitedToken = (tok) => LETTER.test(tok) || NUMERAL.test(tok);

/**
 * The line's text as one syllable per timed word. A token that isn't recited (॥, ॥੧॥) rides on the word
 * before it (or, at the start of the line, the one after), so it takes no time of its own.
 */
export function splitSyllables(text, wordCount, verseId = '?') {
  const syl = [];
  let lead = '';
  for (const tok of text.normalize('NFC').split(/\s+/).filter(Boolean)) {
    if (isRecitedToken(tok)) {
      syl.push(lead + tok);
      lead = '';
    } else if (syl.length) syl[syl.length - 1] += ` ${tok}`;
    else lead += `${tok} `;
  }
  if (syl.length !== wordCount) {
    throw new Error(`Verse ${verseId}: ${syl.length} words in the text but ${wordCount} word timings — wrong text for this recording?`);
  }
  return syl;
}

const cs = (sec) => Math.round(sec * 100);                         // everything below is whole centiseconds
const assTime = (c) => {
  c = Math.max(0, c);
  const h = Math.floor(c / 360000), m = Math.floor(c / 6000) % 60, s = Math.floor(c / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c % 100).padStart(2, '0')}`;
};
/** ASS colour: &HAABBGGRR& from RGB hex. */
export const assColor = (rgb, alpha = 0) => {
  const [r, g, b] = [0, 2, 4].map((i) => rgb.slice(i, i + 2).toUpperCase());
  return `&H${alpha.toString(16).toUpperCase().padStart(2, '0')}${b}${g}${r}&`;
};
const assSafe = (s) => s.replace(/[{}\\]/g, '');                 // a "{" or "\" would be read as a tag

/**
 * What to cut from the recording, in centiseconds: from `padStart` before the first word to `padEnd` after the
 * last (not past the recording's ends).
 */
export function planSlice(lines, { padStart = PAD_START, padEnd = PAD_END, audioSeconds } = {}) {
  const startCs = Math.max(0, cs(lines[0].start) - cs(padStart));
  let endCs = cs(lines[lines.length - 1].end) + cs(padEnd);
  if (audioSeconds !== undefined) {
    if (cs(lines[lines.length - 1].end) > cs(audioSeconds) + 50) {
      throw new Error(`The timings run to ${lines[lines.length - 1].end} s but the recording is ${audioSeconds.toFixed(1)} s long — is it the right file?`);
    }
    endCs = Math.min(endCs, cs(audioSeconds));
  }
  if (endCs <= startCs) throw new Error('Nothing to cut: the slice is empty');
  return { startCs, endCs, start: startCs / 100, end: endCs / 100, duration: (endCs - startCs) / 100 };
}

/**
 * The .ass file: one Dialogue per line, each word a {\k<centiseconds>} syllable, all times relative to the
 * slice (t = 0 is `slice.start` of the recording). A word lasts until the next word starts, the last one
 * until the line ends; boundaries are rounded once, so rounding never adds up to drift.
 */
export function buildAss(lines, slice, { font = DEFAULT_FONT, fontSize = 84 } = {}) {
  const sliceEnd = slice.endCs;
  const timed = lines.map((l) => {
    const syl = splitSyllables(l.text, l.words.length, l.verseId);
    // word starts; never going back in time, whatever the data does
    const b = l.words.map((w, i) => (i ? undefined : cs(w)));
    for (let i = 1; i < b.length; i++) b[i] = Math.max(b[i - 1], cs(l.words[i]));
    const end = Math.max(cs(l.end), b[b.length - 1]);
    return { l, syl, b, end };
  });

  const events = timed.map((t, i) => {
    const prev = timed[i - 1], next = timed[i + 1];
    // Show the line a little before its first word and keep it a little after the last, splitting a short
    // gap between two lines so they never overlap.
    const gapBefore = prev ? Math.max(0, t.b[0] - prev.end) : Infinity;
    const gapAfter = next ? Math.max(0, next.b[0] - t.end) : Infinity;
    const holdPrev = prev ? Math.min(cs(HOLD), Math.floor(gapBefore / 2)) : 0;
    const from = Math.max(slice.startCs, t.b[0] - Math.min(cs(LEAD_IN), gapBefore - holdPrev));
    const to = Math.min(sliceEnd, t.end + Math.min(cs(HOLD), Math.floor(gapAfter / 2)));
    const parts = [];
    if (t.b[0] > from) parts.push(`{\\k${t.b[0] - from}}`);
    t.syl.forEach((s, k) => {
      const dur = (k + 1 < t.b.length ? t.b[k + 1] : t.end) - t.b[k];
      parts.push(`{\\k${dur}}${assSafe(s)}${k + 1 < t.syl.length ? ' ' : ''}`);
    });
    return `Dialogue: 0,${assTime(from - slice.startCs)},${assTime(to - slice.startCs)},${STYLE},,0,0,0,,${parts.join('')}`;
  });

  const { width, height } = VIDEO;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',                  // wrap long lines evenly
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Primary = what a recited word turns into (gold), Secondary = what it is until then (white): see the header.
    `Style: ${STYLE},${font.replace(/,/g, ' ')},${fontSize},${assColor(COLORS.fill)},${assColor(COLORS.text)},${assColor(COLORS.outline)},${assColor('000000', 0x96)},-1,0,0,0,100,100,0,0,1,5,3,5,90,90,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// ── Audio + video ───────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? `${cmd} is not installed (or not on PATH)` : `${cmd}: ${String(stderr || err.message).trim().split('\n').slice(-12).join('\n')}`));
      else resolve(stdout);
    });
  });
}
export async function audioDuration(file) {
  return Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim());
}

/** The recording for a timing file's `<stem>`: --audio as a file, or as a folder holding <stem>.<ext>. */
export async function findAudio(src, stem) {
  const st = await fs.stat(src).catch(() => null);
  if (!st) throw new Error(`Audio not found: ${src}`);
  if (!st.isDirectory()) return src;
  for (const ext of ['mp3', 'm4a', 'wav', 'opus', 'ogg', 'aac', 'flac']) {
    const f = path.join(src, `${stem}.${ext}`);
    if (await fs.stat(f).then(() => true, () => false)) return f;
  }
  throw new Error(`No ${stem}.mp3 (or .m4a, .wav, …) in ${src}`);
}

/** ffmpeg filtergraph text: escape for the option, then for the graph. */
const filterEscape = (s) => s.replace(/[\\':]/g, '\\$&').replace(/[\\',;[\]]/g, '\\$&');
const hex = (s, name) => {
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`${name} should be 6 hex digits, like 1B1F3B`);
  return s;
};

/** One still picture of the background, so ffmpeg doesn't draw a gradient 30 times a second. */
async function makePlate(file, { bg, color, color2 }, cwd) {
  const { width, height } = VIDEO;
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  let src;
  if (bg === 'solid') src = `color=c=0x${hex(color, '--bg-color')}:s=${width}x${height}`;
  else {
    const [r1, g1, b1] = rgb(hex(color, '--bg-color')), [r2, g2, b2] = rgb(hex(color2, '--bg-color2'));
    const ch = (a, b) => `lerp(${a},${b},Y/H)`;
    src = `nullsrc=s=${width}x${height},format=gbrp,geq=r='${ch(r1, r2)}':g='${ch(g1, g2)}':b='${ch(b1, b2)}'`;
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', file], { cwd });
}

/**
 * Plate + the slice of the recording + subtitles → an MP4 (H.264 / AAC, 1080×1920).
 * The slice is `-ss start -to end` on the recording; with `accurateSeek` ffmpeg decodes from the start of it
 * instead of jumping to the spot (slower; for VBR mp3s without a seek table, where a jump can land off).
 */
export async function renderClip({ ass, audio, slice, out, bg = 'gradient', bgColor = COLORS.bgTop, bgColor2 = COLORS.bgBottom, fontsDir, accurateSeek = false, workDir }) {
  const own = !workDir;
  workDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'karaoke-'));
  try {
    await fs.writeFile(path.join(workDir, 'karaoke.ass'), ass, 'utf8');
    await makePlate('plate.png', { bg, color: bgColor, color2: bgColor2 }, workDir);
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const dur = slice.duration.toFixed(2);
    // Subtitles are drawn in RGB so the colours are exactly the style's, then converted the way players expect for HD.
    const vf = [
      'format=gbrp',
      `ass=karaoke.ass${fontsDir ? `:fontsdir=${filterEscape(path.resolve(fontsDir))}` : ''}`,
      'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p',
    ].join(',');
    // A few ms of fade at the cut ends, so they don't click. (The first word is `padStart` away from the cut.)
    const fades = slice.duration > 1 ? [`afade=t=in:d=0.03`, `afade=t=out:st=${(slice.duration - 0.05).toFixed(2)}:d=0.05`] : [];
    // -ss/-to before the recording's -i: ffmpeg jumps there and decodes from the exact spot. Not as output options —
    // those would cut the picture too and shift the subtitles.
    const cut = ['-ss', String(slice.start), '-to', String(slice.end)];
    const af = accurateSeek
      ? [`atrim=start=${slice.start}:end=${slice.end}`, 'asetpts=PTS-STARTPTS', ...fades]
      : fades;
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-loop', '1', '-framerate', String(VIDEO.fps), '-t', dur, '-i', 'plate.png',
      ...(accurateSeek ? [] : cut), '-i', path.resolve(audio),
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', vf, ...(af.length ? ['-af', af.join(',')] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '160k',
      '-t', dur, '-movflags', '+faststart',
      path.resolve(out),
    ], { cwd: workDir });
  } finally {
    if (own) await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ── Command line ────────────────────────────────────────────────────────────
const HELP = `Gurbani clip with word-by-word karaoke subtitles (1080×1920 MP4)

  node karaoke-video.mjs --align <file|folder> --audio <file|folder> --out clip.mp4 [--verses 1-6]

  --align       an Ang's timing file (public/paath/<reciter>/1.json), or the reciter's folder
  --ang         with a folder: only these Angs, e.g. 1 or 1-3 (default: look in all)
  --audio       the recording, or the folder holding <recording>.mp3 (the name in the timing file)
  --verses      verse ids, 5 or 5-9, all from one recording (default: every line found)
  --out         the MP4 to write

  Text (when the timing file has none):
  --text        JSON file {"<verseId>": "ਗੁਰਮੁਖੀ …"}
  --cache-dir   cached Ang pages, as SevaLekh's tools keep them (default .cache/ang); missing ones come from BaniDB
  --banidb-url  BaniDB's address (default ${BANIDB})

  Look:
  --font        font family (default ${DEFAULT_FONT});  --fonts-dir  folder with the font file (default: this repo's fonts/);  --font-size  (default 84)
  --bg          gradient (default) or solid;  --bg-color  ${COLORS.bgTop} (top / the solid colour);  --bg-color2  ${COLORS.bgBottom} (bottom)

  Audio:
  --pad-start / --pad-end   seconds of recording kept before the first word / after the last (default ${PAD_START} / ${PAD_END})
  --accurate-seek           cut by decoding from the start (for VBR mp3s without a seek table)

  --ass <file>   also keep the subtitles;   --ass-only   write them and stop (no video)
`;

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({
    args: argv,
    options: {
      align: { type: 'string' }, ang: { type: 'string' }, audio: { type: 'string' }, verses: { type: 'string' }, out: { type: 'string' },
      text: { type: 'string' }, 'cache-dir': { type: 'string' }, 'banidb-url': { type: 'string' },
      font: { type: 'string' }, 'fonts-dir': { type: 'string' }, 'font-size': { type: 'string' },
      bg: { type: 'string' }, 'bg-color': { type: 'string' }, 'bg-color2': { type: 'string' },
      'pad-start': { type: 'string' }, 'pad-end': { type: 'string' }, 'accurate-seek': { type: 'boolean' },
      ass: { type: 'string' }, 'ass-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help) { console.log(HELP); return; }
  if (!o.align || (!o.audio && !o['ass-only']) || (!o.out && !o['ass-only'])) throw new Error('--align, --audio and --out are needed (see --help)');
  if (o['ass-only'] && !o.ass) throw new Error('--ass-only needs --ass <file>');
  if (o.bg && !['gradient', 'solid'].includes(o.bg)) throw new Error('--bg is gradient or solid');
  const num = (v, name, dflt) => {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} should be a number of seconds, 0 or more`);
    return n;
  };
  const log = (m) => console.log(m);

  const angs = o.ang ? (({ from, to }) => new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i)))(parseRange(o.ang)) : undefined;
  const lines = selectLines(await loadAlignment(o.align, { angs }), o.verses ? parseRange(o.verses) : undefined);
  await attachText(lines, { textFile: o.text, cacheDir: o['cache-dir'] && path.resolve(o['cache-dir']), baniUrl: o['banidb-url'], log });
  // A hole in the verse numbers inside the range = a line the aligner left out; its audio would play unsubtitled.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].verseId !== lines[i - 1].verseId + 1) log(`Note: verses ${lines[i - 1].verseId + 1}–${lines[i].verseId - 1} have no timings; their audio plays without subtitles.`);
  }

  let audio, audioSeconds;
  if (o.audio) {
    audio = await findAudio(o.audio, lines[0].stem);
    audioSeconds = await audioDuration(audio);
  }
  const slice = planSlice(lines, { padStart: num(o['pad-start'], '--pad-start', PAD_START), padEnd: num(o['pad-end'], '--pad-end', PAD_END), audioSeconds });
  const fontSize = o['font-size'] === undefined ? undefined : Number(o['font-size']);
  if (fontSize !== undefined && !(fontSize >= 10 && fontSize <= 400)) throw new Error('--font-size should be a number of pixels, 10 to 400');
  const ass = buildAss(lines, slice, { font: o.font, fontSize });
  if (o.ass) { await fs.mkdir(path.dirname(path.resolve(o.ass)), { recursive: true }); await fs.writeFile(o.ass, ass, 'utf8'); }
  log(`${lines.length} lines, verses ${lines[0].verseId}–${lines[lines.length - 1].verseId} of ${lines[0].stem}: ${slice.start}–${slice.end} s (${slice.duration.toFixed(2)} s)`);
  if (o['ass-only']) return;

  const t0 = Date.now();
  await renderClip({
    ass, audio, slice, out: o.out, bg: o.bg, bgColor: o['bg-color'], bgColor2: o['bg-color2'],
    // The repo's own fonts/ (Noto Sans Gurmukhi) unless another folder is given, so no font needs installing.
    fontsDir: o['fonts-dir'] ?? REPO_FONTS, accurateSeek: o['accurate-seek'],
  });
  log(`${o.out} (${((await fs.stat(o.out)).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 100) / 10} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`karaoke-video: ${e.message}`); process.exit(1); });
}
