#!/usr/bin/env node
/**
 * A stand-in "recording" for trying karaoke-video.mjs without the real one: silence with a 90 ms beep at every
 * word start in an alignment file (pitch rising along the line), as an mp3 named after the file's recording.
 *
 *   node samples/karaoke/make-mock-audio.mjs samples/karaoke/alignment/1.json out/mock-audio
 *   → out/mock-audio/Ang-0001-0013.mp3
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MOCK_RATE = 22050;
export const BEEP = 0.09;   // s

/** @returns the path written: <outDir>/<recording>.mp3 */
export async function makeMockRecording(alignFile, outDir, { seconds = 36 } = {}) {
  const j = JSON.parse(await fs.readFile(alignFile, 'utf8'));
  const stem = j.lines[0][1];
  const pcm = new Int16Array(Math.round(seconds * MOCK_RATE));
  const n = Math.round(BEEP * MOCK_RATE);
  for (const line of j.lines) {
    line[4].forEach((start, k) => {
      const freq = 330 * 2 ** (k / 12), at = Math.round(start * MOCK_RATE);
      for (let i = 0; i < n && at + i < pcm.length; i++) {
        const env = Math.sin(Math.PI * i / n) ** 2;                    // soft edges: no clicks
        pcm[at + i] = Math.round(0.6 * 32767 * env * Math.sin(2 * Math.PI * freq * i / MOCK_RATE));
      }
    });
  }
  const data = Buffer.from(pcm.buffer);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(MOCK_RATE, 24); hdr.writeUInt32LE(MOCK_RATE * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);

  await fs.mkdir(outDir, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-audio-'));
  try {
    const wav = path.join(tmp, 'mock.wav'), out = path.join(outDir, `${stem}.mp3`);
    await fs.writeFile(wav, Buffer.concat([hdr, data]));
    await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '64k', out],
      (err, _o, stderr) => (err ? rej(new Error(`ffmpeg: ${stderr || err.message}`)) : res())));
    return out;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [align, outDir] = process.argv.slice(2);
  if (!align || !outDir) { console.error('usage: node make-mock-audio.mjs <alignment .json> <output folder>'); process.exit(1); }
  makeMockRecording(align, outDir).then((f) => console.log(f), (e) => { console.error(e.message); process.exit(1); });
}
