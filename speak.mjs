/**
 * 🗣 The robot's voice for the MukhWak's spoken meanings.
 *
 *   🔵 Azure AI Speech (free tier F0) — when the secrets AZURE_TTS_KEY and
 *      AZURE_TTS_REGION are set: Microsoft's published service.
 *   🟣 edge-tts — otherwise (pip install edge-tts): Edge's read-aloud voices,
 *      unofficial; may stop working when Edge updates.
 *
 * Edge has no Punjabi voice: its Hindi voice reads the Punjabi, written in
 * Devanagari (the same letter-for-letter change the app makes, speech.ts).
 * Returns base64 MP3. Each text is spoken once per run (video + audio share it).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KEY = (process.env.AZURE_TTS_KEY || '').trim();
const REGION = (process.env.AZURE_TTS_REGION || '').trim().toLowerCase();
export const ENGINE = KEY && REGION ? 'azure' : 'edge';
const LOCALE = { pa: 'pa-IN', pnb: 'ur-PK', hi: 'hi-IN', ur: 'ur-PK', en: 'en-IN' };
const GENDER = (process.env.TTS_GENDER || 'Male') === 'Female' ? 'Female' : 'Male';
export let charsUsed = 0;

export function toDevanagari(text) {
  return text
    .replace(/ਸ਼/g, 'ਸ਼')
    .replace(/ੴ/g, 'एक ओंकार')
    .replace(/ੱ([ਕ-ਹਖ਼-ਫ਼])/g, '$1੍$1')
    .replace(/ੲਿ/g, 'इ').replace(/ੲੀ/g, 'ई').replace(/ੲੇ/g, 'ए').replace(/ੲ/g, 'इ')
    .replace(/ੳੁ/g, 'उ').replace(/ੳੂ/g, 'ऊ').replace(/ੳੋ/g, 'ओ').replace(/ੳ/g, 'उ')
    .replace(/[ੱੑ]/g, '')
    .replace(/ੰ/g, 'ं')
    .replace(/ੵ/g, '्य')
    .replace(/[ਁ-੯]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x100));
}

let azVoices = null;
async function azureVoice(locale) {
  if (!azVoices) {
    const r = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': KEY } });
    if (!r.ok) throw new Error(`Azure voices: HTTP ${r.status}`);
    azVoices = await r.json();
  }
  const all = azVoices.filter((v) => v.Locale === locale && !/Multilingual|:/.test(v.ShortName));
  return (all.find((v) => v.Gender === GENDER) ?? all[0])?.ShortName ?? null;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function azure(text, lang) {
  let locale = LOCALE[lang] ?? 'en-IN';
  let voice = await azureVoice(locale);
  if (!voice && lang === 'pa') { locale = 'hi-IN'; text = toDevanagari(text); voice = await azureVoice(locale); }
  if (!voice) throw new Error(`no Azure voice for ${locale}`);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}"><prosody rate="-6%">${esc(text)}</prosody></voice></speak>`;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'sevalekh-robot' },
      body: ssml,
    });
    if (r.ok) { charsUsed += text.length; return Buffer.from(await r.arrayBuffer()); }
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 5000 * (i + 1))); continue; }
    throw new Error(`Azure: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`);
  }
  throw new Error('Azure: busy (429)');
}

async function edge(text, lang) {
  const pa = lang === 'pa';
  const voiceFor = { 'hi-IN': GENDER === 'Female' ? 'hi-IN-SwaraNeural' : 'hi-IN-MadhurNeural', 'en-IN': GENDER === 'Female' ? 'en-IN-NeerjaNeural' : 'en-IN-PrabhatNeural',
    'ur-PK': GENDER === 'Female' ? 'ur-PK-UzmaNeural' : 'ur-PK-AsadNeural' };
  const locale = pa ? 'hi-IN' : LOCALE[lang] ?? 'en-IN';
  const voice = voiceFor[locale] ?? voiceFor['en-IN'];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-'));
  const tf = path.join(dir, 't.txt'), mf = path.join(dir, 'a.mp3');
  await fs.writeFile(tf, pa ? toDevanagari(text) : text);
  for (let i = 0; i < 3; i++) {
    try {
      await new Promise((res, rej) => execFile('edge-tts', ['--voice', voice, '--rate=-6%', '-f', tf, '--write-media', mf],
        { timeout: 120_000 }, (e, _o, se) => (e ? rej(new Error(String(se || e.message).slice(-300))) : res())));
      const b = await fs.readFile(mf);
      if (b.length > 1000) { charsUsed += text.length; await fs.rm(dir, { recursive: true, force: true }); return b; }
    } catch (e) { if (i === 2) { await fs.rm(dir, { recursive: true, force: true }); throw e; } }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  throw new Error('edge-tts gave no audio');
}

const cache = new Map();
/** text, SevaLekh language → base64 MP3 */
export async function robotSpeak(text, lang) {
  const k = `${lang}\n${text}`;
  if (!cache.has(k)) cache.set(k, (ENGINE === 'azure' ? azure(text, lang) : edge(text, lang)).then((b) => b.toString('base64')));
  try { return await cache.get(k); } catch (e) { cache.delete(k); throw e; }
}
