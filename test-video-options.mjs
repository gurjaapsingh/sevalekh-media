import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHOP_SPEED,
  normalizeAdminChopSpeed,
  resolveRequestedChop,
  listChopVariants,
  fullVideoOption,
  fitVideoOption,
} from './video-options.mjs';

describe('admin chop speed', () => {
  test('defaults to 1.6x when missing or invalid', () => {
    assert.equal(DEFAULT_CHOP_SPEED, 1.6);
    assert.equal(normalizeAdminChopSpeed(undefined), 1.6);
    assert.equal(normalizeAdminChopSpeed('bad'), 1.6);
  });

  test('keeps valid explicit admin override', () => {
    assert.equal(normalizeAdminChopSpeed('2'), 2);
    assert.equal(normalizeAdminChopSpeed(1), 1);
  });
});

describe('custom request parsing and validation', () => {
  test('accepts paired override: "1.8x 75s"', () => {
    const r = resolveRequestedChop({ request: '1.8x 75s', audioSeconds: 400 });
    assert.equal(r.mode, 'custom');
    assert.equal(r.speed, 1.8);
    assert.equal(r.durationSeconds, 75);
    assert.equal(r.sourceSeconds, 135);
  });

  test('accepts paired override: speed=... time=...', () => {
    const r = resolveRequestedChop({ request: 'speed=1.8 time=75', audioSeconds: 400 });
    assert.equal(r.mode, 'custom');
    assert.equal(r.speed, 1.8);
    assert.equal(r.durationSeconds, 75);
  });

  test('rejects incomplete custom override', () => {
    const speedOnly = resolveRequestedChop({ request: '1.8x', audioSeconds: 400 });
    const timeOnly = resolveRequestedChop({ request: '75s', audioSeconds: 400 });
    assert.equal(speedOnly.mode, 'invalid');
    assert.equal(timeOnly.mode, 'invalid');
    assert.match(speedOnly.message, /both speed and time/i);
  });

  test('rejects out-of-range values', () => {
    assert.equal(resolveRequestedChop({ request: '4.5x 75s', audioSeconds: 400 }).mode, 'invalid');
    assert.equal(resolveRequestedChop({ request: '1.8x 3s', audioSeconds: 400 }).mode, 'invalid');
    assert.equal(resolveRequestedChop({ request: '1.8x 75s', audioSeconds: 100 }).mode, 'invalid');
  });
});

describe('video option helpers', () => {
  test('chop variant metadata includes speed and source duration', () => {
    const chops = listChopVariants({ reel: 90 }, 1.6, 300);
    assert.deepEqual(chops, [{ key: 'reel', speed: 1.6, durationSeconds: 90, sourceSeconds: 144 }]);
  });

  test('full stays at normal speed and fit is calculated independently', () => {
    assert.deepEqual(fullVideoOption(360), { speed: 1, durationSeconds: 360 });
    const fit = fitVideoOption(360, 179);
    assert.equal(fit.speed, 2.02);
    assert.ok(fit.durationSeconds <= 179);
  });
});
