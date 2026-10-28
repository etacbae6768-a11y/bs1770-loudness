// SPDX-License-Identifier: MIT
// Conformance checks against EBU Tech 3341 (integrated loudness, +-0.1 LU) and EBU Tech 3342
// (loudness range, +-1 LU), plus the true peak of sines whose peaks fall between samples.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLoudness } from '../index.mjs';

const FS = 48000;

// 1 kHz stereo sine programme from [dBFS, seconds] segments (peak amplitude 10^(dB/20)).
function programme(segs, fs = FS, f = 1000) {
  const n = segs.reduce((a, [, s]) => a + Math.round(s * fs), 0);
  const x = new Float32Array(n);
  let i = 0;
  for (const [db, s] of segs) {
    const a = 10 ** (db / 20);
    const m = Math.round(s * fs);
    for (let k = 0; k < m; k++, i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / fs);
  }
  return [x, x];
}
const near = (v, want, tol) => v !== null && Math.abs(v - want) <= tol;

const tech3341 = [
  ['case 1: -23 dBFS, 20 s', [[-23, 20]], -23],
  ['case 2: -33 dBFS, 20 s', [[-33, 20]], -33],
  ['case 3: -36 / -23 / -36 dBFS', [[-36, 10], [-23, 60], [-36, 10]], -23],
  ['case 4: -72 / -36 / -23 / -36 / -72 dBFS', [[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]], -23],
  ['case 5: -26 / -20 / -26 dBFS', [[-26, 20], [-20, 20.1], [-26, 20]], -23],
];
for (const [name, segs, want] of tech3341) {
  test('EBU Tech 3341 ' + name, () => {
    const r = measureLoudness(programme(segs), FS);
    assert.ok(near(r.integrated, want, 0.1), 'integrated = ' + r.integrated);
  });
}

const tech3342 = [
  ['case 1: -20 / -30 dBFS', [[-20, 20], [-30, 20]], 10],
  ['case 2: -20 / -15 dBFS', [[-20, 20], [-15, 20]], 5],
  ['case 3: -40 / -20 dBFS', [[-40, 20], [-20, 20]], 20],
  ['case 4: -50 / -35 / -20 / -35 / -50 dBFS', [[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]], 15],
];
for (const [name, segs, want] of tech3342) {
  test('EBU Tech 3342 ' + name, () => {
    const r = measureLoudness(programme(segs), FS);
    assert.ok(near(r.lra, want, 1), 'lra = ' + r.lra);
  });
}

for (const [f, ph] of [[12000, Math.PI / 4], [11025, 0.3], [9000, 1.1], [997, 0.5]]) {
  test('true peak of a -6.02 dBFS sine at ' + f + ' Hz', () => {
    const x = new Float32Array(FS);
    for (let i = 0; i < FS; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / FS + ph);
    const r = measureLoudness([x, x], FS);
    assert.ok(near(r.truePeak, -6.02, 0.2), 'truePeak = ' + r.truePeak);
    assert.ok(r.truePeak >= r.samplePeak - 1e-9, 'true peak >= sample peak');
  });
}

test('44.1 kHz: a -23 dBFS 1 kHz stereo sine reads -23 LUFS', () => {
  const r = measureLoudness(programme([[-23, 20]], 44100), 44100);
  assert.ok(near(r.integrated, -23, 0.1), 'integrated = ' + r.integrated);
});

test('silence: integrated loudness is null, never NaN', () => {
  const z = new Float32Array(FS * 2);
  const r = measureLoudness([z, z], FS);
  assert.equal(r.integrated, null);
});

test('shorter than one 400 ms block: null loudness, no throw', () => {
  const x = new Float32Array(FS / 10);
  const r = measureLoudness([x], FS);
  assert.equal(r.integrated, null);
});

test('invalid sample rate throws LoudnessError with a reason', () => {
  assert.throws(() => measureLoudness([new Float32Array(10)], 100), (e) => e.name === 'LoudnessError' && e.details.reason === 'sample_rate');
});
