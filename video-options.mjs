export const DEFAULT_CHOP_SPEED = 1.6;
export const MIN_CUSTOM_SPEED = 1;
export const MAX_CUSTOM_SPEED = 4;
export const MIN_CUSTOM_DURATION_SECONDS = 5;

const round2 = (n) => Math.round(n * 100) / 100;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function parseSpeed(value, { allowOne = false } = {}) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (raw === '' || raw === undefined || raw === null) return { ok: false, reason: 'missing' };
  const s = typeof raw === 'string' ? raw.replace(/^x/, '').replace(/x$/, '') : raw;
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not-a-number' };
  if (n > MAX_CUSTOM_SPEED || (!allowOne && n <= MIN_CUSTOM_SPEED) || (allowOne && n < MIN_CUSTOM_SPEED)) {
    return { ok: false, reason: 'out-of-range' };
  }
  return { ok: true, value: round2(n) };
}

function parseDurationSeconds(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (raw === '' || raw === undefined || raw === null) return { ok: false, reason: 'missing' };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'not-a-number' };
    return { ok: true, value: raw };
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) return { ok: true, value: Number(raw) };
  if (/^\d+(?:\.\d+)?s$/.test(raw)) return { ok: true, value: Number(raw.slice(0, -1)) };
  const ms = raw.match(/^(\d+)m(?:\s*(\d+(?:\.\d+)?)s?)?$/);
  if (ms) return { ok: true, value: Number(ms[1]) * 60 + Number(ms[2] || 0) };
  const clock = raw.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (clock) return { ok: true, value: Number(clock[1]) * 60 + Number(clock[2]) };
  return { ok: false, reason: 'bad-format' };
}

function readRequestParts(request) {
  if (!request) return { hasSpeed: false, hasDuration: false };
  if (typeof request === 'string') {
    const text = request.trim();
    let speedRaw = null;
    let durationRaw = null;
    for (const m of text.matchAll(/(?:^|[\s,;])(?:speed|sp|rate)\s*[:=]\s*([0-9]*\.?[0-9]+x?)/ig)) speedRaw = m[1];
    for (const m of text.matchAll(/(?:^|[\s,;])(?:time|duration|dur|seconds|sec|t)\s*[:=]\s*([0-9:.]*\.?[0-9]+(?:m(?:\s*\d+(?:\.\d+)?s?)?|s)?)/ig)) durationRaw = m[1];
    if (!speedRaw || !durationRaw) {
      for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
        if (!speedRaw && /^\d+(?:\.\d+)?x$/i.test(token)) speedRaw = token;
        if (!durationRaw && (/^\d+(?:\.\d+)?s$/i.test(token) || /^\d+m(?:\d+(?:\.\d+)?s?)?$/i.test(token) || /^\d+:[0-5]?\d(?:\.\d+)?$/.test(token))) durationRaw = token;
      }
    }
    return { hasSpeed: speedRaw != null, hasDuration: durationRaw != null, speedRaw, durationRaw };
  }
  if (isObj(request)) {
    const speedRaw = request.speed ?? request.chopSpeed ?? request.rate;
    const durationRaw = request.duration ?? request.time ?? request.seconds;
    return { hasSpeed: speedRaw != null, hasDuration: durationRaw != null, speedRaw, durationRaw };
  }
  return { hasSpeed: false, hasDuration: false };
}

export function normalizeAdminChopSpeed(value, fallback = DEFAULT_CHOP_SPEED) {
  const parsed = parseSpeed(value, { allowOne: true });
  return parsed.ok ? parsed.value : fallback;
}

export function resolveRequestedChop({ request, audioSeconds, onIncomplete = 'reject' } = {}) {
  const parts = readRequestParts(request);
  if (!parts.hasSpeed && !parts.hasDuration) return { mode: 'none' };
  if (!parts.hasSpeed || !parts.hasDuration) {
    const message = 'Please send both speed and time together, e.g. "1.8x 75s" or "speed=1.8 time=75".';
    if (onIncomplete === 'reject') return { mode: 'invalid', message, code: 'incomplete' };
    return { mode: 'none' };
  }
  const speed = parseSpeed(parts.speedRaw);
  if (!speed.ok) {
    return { mode: 'invalid', code: 'speed', message: `Speed must be greater than ${MIN_CUSTOM_SPEED} and at most ${MAX_CUSTOM_SPEED}.` };
  }
  const duration = parseDurationSeconds(parts.durationRaw);
  if (!duration.ok || duration.value < MIN_CUSTOM_DURATION_SECONDS) {
    return { mode: 'invalid', code: 'duration', message: `Time must be at least ${MIN_CUSTOM_DURATION_SECONDS} seconds.` };
  }
  const sourceSeconds = duration.value * speed.value;
  if (audioSeconds && sourceSeconds > audioSeconds) {
    return { mode: 'invalid', code: 'duration', message: `That request needs ${Math.ceil(sourceSeconds)} seconds of source audio, but today's recording is ${Math.floor(audioSeconds)} seconds.` };
  }
  return {
    mode: 'custom',
    speed: speed.value,
    durationSeconds: round2(duration.value),
    sourceSeconds: round2(sourceSeconds),
  };
}

export function listChopVariants(chops, speed, audioSeconds) {
  return Object.entries(chops)
    .map(([key, durationSeconds]) => ({
      key,
      speed,
      durationSeconds,
      sourceSeconds: round2(durationSeconds * speed),
    }))
    .filter((v) => v.sourceSeconds < audioSeconds);
}

export function fullVideoOption(audioSeconds) {
  return { speed: 1, durationSeconds: audioSeconds };
}

export function fitVideoOption(audioSeconds, targetSeconds = 179) {
  if (!(audioSeconds > targetSeconds)) return null;
  const speed = round2(Math.ceil((audioSeconds / targetSeconds) * 100) / 100);
  return { speed, durationSeconds: audioSeconds / speed };
}
