// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Park Jihoon (Tools That Don't Upload). https://toolsthatdontupload.com
// Loudness and peak measurement.
// Sources: ITU-R BS.1770-4 (10/2015): 2.1 K-weighting (Tables 1 and 2: the 48 kHz pre-filter and
// RLB filter coefficients), 2.4 mean square over 400 ms gating blocks with 75 % overlap, 2.5 channel
// weights (1.0 front, 1.41 surround, LFE excluded), 2.8 gating (absolute -70 LKFS, relative -10 LU),
// Annex 2 true-peak (over-sampled peak). EBU Tech 3341 (momentary 400 ms, short-term 3 s, test
// signals), EBU Tech 3342 (loudness range: short-term values, -70 LUFS absolute gate, -20 LU relative
// gate, 10th and 95th percentiles), EBU R 128 (target -23 LUFS).
// Other sample rates: the 48 kHz biquads are mapped to an analogue prototype with the inverse
// bilinear transform and re-discretised at the target rate (identical at 48 kHz).
// True peak: our own polyphase windowed-sinc interpolator (Kaiser window), 4x or more over-sampling,
// candidate blocks found with a short filter, final value from a long filter plus parabolic
// refinement around the largest over-sampled point.
// Runtime-agnostic, streaming (memory independent of the input length apart from per-100 ms energies).
import * as DM from './dmath.mjs';

const STAGE1_48K = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
const STAGE2_48K = { b: [1.0, -2.0, 1.0], a: [1, -1.99004745483398, 0.99007225036621] };

/** Analogue prototype A s^2 + B s + C over D s^2 + E s + F of a digital biquad (bilinear constant K). */
function toAnalog(f, K) {
  const [b0, b1, b2] = f.b;
  const [, a1, a2] = f.a;
  return { n: [b0 - b1 + b2, K * (b0 - b2) * 2, K * K * (b0 + b1 + b2)], d: [1 - a1 + a2, K * (1 - a2) * 2, K * K * (1 + a1 + a2)] };
}
function magDb(p, w) {
  // |p(jw)| for p = [A, B, C]: (C - A w^2) + j B w
  const re = p[2] - p[0] * w * w;
  const im = p[1] * w;
  return 10 * DM.log10(re * re + im * im);
}
/**
 * Natural frequency of the poles of a 48 kHz K-weighting stage (w0^2 = F / D of the analogue
 * denominator D s^2 + E s + F), derived from the stage's own coefficients. The analogue prototype
 * depends on the pre-warping frequency, so it is found by fixed-point iteration: pre-warp at w0,
 * recompute w0, until it no longer changes.
 */
function cornerHz(f) {
  let w = Math.sqrt(toAnalog(f, 2 * 48000).d[2] / toAnalog(f, 2 * 48000).d[0]);
  for (let i = 0; i < 200; i++) {
    const a = toAnalog(f, w / DM.tan(w / (2 * 48000)));
    const nw = Math.sqrt(a.d[2] / a.d[0]);
    if (Math.abs(nw - w) < 1e-12 * w) { w = nw; break; }
    w = nw;
  }
  return w / (2 * Math.PI);
}
const CORNER = [cornerHz(STAGE1_48K), cornerHz(STAGE2_48K)];
void magDb;

/**
 * Re-discretise a 48 kHz biquad at sample rate fs: inverse bilinear transform at 48 kHz and bilinear
 * transform at fs, both pre-warped at the stage's characteristic frequency fc, so the response is
 * identical at 48 kHz and matches exactly at fc for every other rate.
 */
export function remapBiquad(f, fs, fc) {
  const w = 2 * Math.PI * fc;
  const K0 = w / DM.tan(w / (2 * 48000));
  const a = toAnalog(f, K0);
  const k = w / DM.tan(w / (2 * fs));
  const k2 = k * k;
  const z = ([A, B, C]) => [A * k2 + B * k + C, -2 * A * k2 + 2 * C, A * k2 - B * k + C];
  const nb = z(a.n);
  const da = z(a.d);
  return { b: [nb[0] / da[0], nb[1] / da[0], nb[2] / da[0]], a: [1, da[1] / da[0], da[2] / da[0]] };
}

export function kWeighting(fs) {
  return fs === 48000 ? [STAGE1_48K, STAGE2_48K] : [remapBiquad(STAGE1_48K, fs, CORNER[0]), remapBiquad(STAGE2_48K, fs, CORNER[1])];
}
export const K_CORNERS_HZ = CORNER;

/** Channel weights by count (FLAC / WAVE default orders), or from a WAVE channel mask. */
export function channelWeights(n, mask) {
  if (mask) {
    // speaker bits: FL FR FC LFE BL BR FLC FRC BC SL SR TC TFL TFC TFR TBL TBC TBR
    const W = [1, 1, 1, 0, 1.41, 1.41, 1, 1, 1.41, 1.41, 1.41, 1, 1, 1, 1, 1, 1, 1];
    const out = [];
    for (let bit = 0; bit < 18 && out.length < n; bit++) if (mask & (1 << bit)) out.push(W[bit]);
    while (out.length < n) out.push(1);
    return out;
  }
  const table = { 1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [1, 1, 1.41, 1.41], 5: [1, 1, 1, 1.41, 1.41], 6: [1, 1, 1, 0, 1.41, 1.41], 7: [1, 1, 1, 0, 1.41, 1.41, 1.41], 8: [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41] };
  return table[n] || Array.from({ length: n }, () => 1);
}

// ---------------------------------------------------------------- true peak interpolator

function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 64; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-17 * s) break; } return s; }

/** Polyphase interpolation filter: phases[p][k] for output offset p/F, taps k = -half+1..half. */
function design(F, half, beta, cutoff) {
  const phases = [];
  const i0b = bessel0(beta);
  for (let p = 0; p < F; p++) {
    const h = new Float64Array(2 * half);
    let sum = 0;
    for (let k = 0; k < 2 * half; k++) {
      const t = k - half + 1 - p / F; // distance in input samples from the output position
      const x = cutoff * t;
      const sinc = x === 0 ? 1 : DM.sin(Math.PI * x) / (Math.PI * x);
      const r = t / half;
      const w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0b;
      h[k] = cutoff * sinc * w;
      sum += h[k];
    }
    // unity DC gain per phase
    for (let k = 0; k < 2 * half; k++) h[k] /= sum;
    phases.push(h);
  }
  return phases;
}
const FILTERS = new Map();
function filterFor(F, half, beta, cutoff) {
  const key = `${F}/${half}/${beta}/${cutoff}`;
  let f = FILTERS.get(key);
  if (!f) { f = design(F, half, beta, cutoff); FILTERS.set(key, f); }
  return f;
}

/** Value of the band-limited interpolation at x[i] + p/F (taps from i-half+1 .. i+half). */
function interp(x, n, i, h, half) {
  let s = 0;
  const from = i - half + 1;
  for (let k = 0; k < 2 * half; k++) {
    const j = from + k;
    if (j >= 0 && j < n) s += h[k] * x[j];
  }
  return s;
}

/**
 * True peak (linear) of one channel. Stage 1: short filter, 4x, per 64-sample block maximum.
 * Stage 2: blocks whose stage-1 peak is within 1 dB of the best are re-evaluated with a long
 * filter at 8x, and the largest point is refined with a parabola through its neighbours.
 */
const F2 = 16;
const H2 = 32;
export function truePeak(x, fs) {
  const n = x.length;
  if (n === 0) return 0;
  let sp = 0;
  for (let i = 0; i < n; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > sp) sp = a; }
  if (sp === 0) return 0;
  const B = 64;
  const nb = Math.ceil(n / B);
  const blockMax = new Float64Array(nb);
  const F1 = 4;
  const H1 = 6;
  const h1 = filterFor(F1, H1, 6, 0.92);
  let best1 = sp;
  // stage 1 (blocks that cannot exceed best1 by more than the short-filter error are skipped)
  const l1 = h1.reduce((m, h) => Math.max(m, h.reduce((s, v) => s + Math.abs(v), 0)), 0);
  for (let b = 0; b < nb; b++) {
    const from = b * B;
    const to = Math.min(n, from + B);
    let local = 0;
    for (let i = Math.max(0, from - H1); i < Math.min(n, to + H1); i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > local) local = a; }
    if (local * l1 < best1 * 0.8) { blockMax[b] = local; continue; }
    let m = 0;
    for (let i = from; i < to; i++) {
      const a0 = x[i] < 0 ? -x[i] : x[i];
      if (a0 > m) m = a0;
      // interpolate only where the whole filter support lies inside the signal (no edge ringing)
      if (i < H2 || i + H2 >= n) continue;
      for (let p = 1; p < F1; p++) { const v = interp(x, n, i, h1[p], H1); const a = v < 0 ? -v : v; if (a > m) m = a; }
    }
    blockMax[b] = m;
    if (m > best1) best1 = m;
  }
  // stage 2 on candidate blocks
  const h2 = filterFor(F2, H2, 9, 0.98);
  let best = sp;
  let bi = -1;
  let bp = 0;
  const thr = best1 * DM.pow(10, -1 / 20);
  // The peak of the band-limited signal lies within one step of a local maximum of the 4x grid, so the
  // fine (16x, long filter) evaluation runs only around grid local maxima above the threshold.
  const R = F2 / F1;
  const G = new Float64Array((B + 2) * F1);
  for (let b = 0; b < nb; b++) {
    if (blockMax[b] < thr) continue;
    const from = b * B;
    const to = Math.min(n, from + B);
    const g0 = from - 1;
    const cnt = (to + 1 - g0) * F1;
    for (let s = g0; s <= to; s++) {
      for (let p = 0; p < F1; p++) {
        let v = 0;
        if (s >= 0 && s < n) v = p === 0 ? x[s] : s < H2 || s + H2 >= n ? 0 : interp(x, n, s, h1[p], H1);
        G[(s - g0) * F1 + p] = v < 0 ? -v : v;
      }
    }
    for (let k = F1; k < cnt - F1; k++) {
      const gv = G[k];
      if (gv < thr || gv < G[k - 1] || gv < G[k + 1]) continue;
      const s = g0 + Math.floor(k / F1);
      const centre = (k % F1) * R;
      for (let d = -R; d <= R; d++) {
        let ii = s;
        let pp = centre + d;
        while (pp < 0) { pp += F2; ii--; }
        while (pp >= F2) { pp -= F2; ii++; }
        if (ii < H2 || ii + H2 >= n) continue;
        const v = pp === 0 ? x[ii] : interp(x, n, ii, h2[pp], H2);
        const a = v < 0 ? -v : v;
        if (a > best) { best = a; bi = ii; bp = pp; }
      }
    }
  }
  if (bi < 0) return best;
  // parabolic refinement through the neighbours of the largest point (step 1/F2)
  const at = (i, p) => {
    while (p < 0) { p += F2; i--; }
    while (p >= F2) { p -= F2; i++; }
    if (i < 0 || i >= n) return 0;
    return Math.abs(p === 0 ? x[i] : interp(x, n, i, h2[p], H2));
  };
  const y0 = at(bi, bp - 1);
  const y1 = best;
  const y2 = at(bi, bp + 1);
  const den = y0 - 2 * y1 + y2;
  if (den < 0) {
    const d = 0.5 * (y0 - y2) / den;
    if (Math.abs(d) <= 1) best = Math.max(best, y1 - 0.25 * (y0 - y2) * d);
  }
  return best;
}

// ---------------------------------------------------------------- loudness

const LOG = (v) => -0.691 + 10 * DM.log10(v);
const db = (v) => (v > 0 ? 20 * DM.log10(v) : null);

/** Percentile with linear interpolation between closest ranks (p in 0..1, sorted ascending input). */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

/** Input that cannot be measured: code 'invalid_input' with details.reason (still a RangeError for older callers). */
export class LoudnessError extends RangeError {
  constructor(message, reason) { super(message); this.name = 'LoudnessError'; this.code = 'invalid_input'; this.details = { reason }; }
}

/**
 * Measure loudness and peaks.
 * Abnormal input never yields NaN: empty or shorter-than-400 ms input gives null loudness ('shorter_than_block'),
 * non-finite samples count as silence ('non_finite_samples'), channels of different length are measured over the
 * shortest one ('channel_length_mismatch'); a missing channel list or an unsupported rate throws LoudnessError.
 * channels: Float32Array[] (or Float64Array[]), full scale = 1.0. Channels of different length are
 * measured over the shortest one (warning 'channel_length_mismatch').
 * opts: { weights | channelMask, target = -23, tpCeiling = -1, checkpoint }
 * Returns JSON-safe values (null when undefined, e.g. the integrated loudness of silence):
 * { integrated, momentaryMax, shortTermMax, lra, lraLow, lraHigh, truePeak, samplePeak,
 *   gainToTarget, gainToTargetPeakLimited, blocks, gatedBlocks, shortTermValues, nonFinite, warnings }
 */
export function measureLoudness(channels, fs, opts = {}) {
  if (!Array.isArray(channels) || channels.some((c) => !c || typeof c.length !== 'number')) throw new LoudnessError('channels must be an array of sample arrays', 'channels');
  const nch = channels.length;
  if (!Number.isInteger(fs) || fs < 8000 || fs > 384000) throw new LoudnessError('sample rate out of range', 'sample_rate');
  if (nch < 1) throw new LoudnessError('no channels', 'channels');
  const warnings = [];
  let n = channels[0].length;
  for (const c of channels) { if (c.length !== n) { if (!warnings.includes('channel_length_mismatch')) warnings.push('channel_length_mismatch'); n = Math.min(n, c.length); } }
  const weights = opts.weights || channelWeights(nch, opts.channelMask);
  const [s1, s2] = kWeighting(fs);
  const segs = Math.floor((n * 10) / fs);
  const segStart = (k) => Math.round((k * fs) / 10);
  const segE = new Float64Array(Math.max(1, segs));
  const segLen = new Float64Array(Math.max(1, segs));
  for (let k = 0; k < segs; k++) segLen[k] = segStart(k + 1) - segStart(k);
  let nonFinite = 0;
  let samplePeak = 0;
  let truePk = 0;
  const b10 = s1.b[0], b11 = s1.b[1], b12 = s1.b[2], a11 = s1.a[1], a12 = s1.a[2];
  const b20 = s2.b[0], b21 = s2.b[1], b22 = s2.b[2], a21 = s2.a[1], a22 = s2.a[2];
  for (let c = 0; c < nch; c++) {
    if (opts.checkpoint) opts.checkpoint();
    let x = channels[c];
    const g = weights[c] === undefined ? 1 : weights[c];
    // non-finite samples count as silence
    let bad = 0;
    for (let i = 0; i < n; i++) { const v = x[i]; if (v !== v || v === Infinity || v === -Infinity) bad++; }
    if (bad) {
      nonFinite += bad;
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) { const v = x[i]; y[i] = v !== v || v === Infinity || v === -Infinity ? 0 : v; }
      x = y;
    }
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, o1 = 0, o2 = 0;
    let k = 0;
    let next = segs > 0 ? segStart(1) : Infinity;
    let acc = 0;
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const av = v < 0 ? -v : v;
      if (av > pk) pk = av;
      const y = b10 * v + b11 * x1 + b12 * x2 - a11 * y1 - a12 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      const o = b20 * y + b21 * u1 + b22 * u2 - a21 * o1 - a22 * o2;
      u2 = u1; u1 = y; o2 = o1; o1 = o;
      acc += o * o;
      if (i + 1 === next) {
        segE[k] += g * acc;
        acc = 0;
        k++;
        next = k < segs ? segStart(k + 1) : Infinity;
      }
    }
    if (pk > samplePeak) samplePeak = pk;
    const tp = truePeak(n === x.length ? x : x.subarray(0, n), fs);
    if (tp > truePk) truePk = tp;
  }
  // gating blocks (400 ms = 4 segments, step 100 ms)
  const nBlocks = Math.max(0, segs - 3);
  const blockZ = new Float64Array(nBlocks);
  let momentaryMax = null;
  for (let j = 0; j < nBlocks; j++) {
    const e = segE[j] + segE[j + 1] + segE[j + 2] + segE[j + 3];
    const l = segLen[j] + segLen[j + 1] + segLen[j + 2] + segLen[j + 3];
    blockZ[j] = e / l;
    if (blockZ[j] > 0) { const m = LOG(blockZ[j]); if (momentaryMax === null || m > momentaryMax) momentaryMax = m; }
  }
  let integrated = null;
  let gated = 0;
  {
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < nBlocks; j++) if (blockZ[j] > 0 && LOG(blockZ[j]) > -70) { sum += blockZ[j]; cnt++; }
    if (cnt) {
      const rel = LOG(sum / cnt) - 10;
      let s2 = 0;
      let c2 = 0;
      for (let j = 0; j < nBlocks; j++) if (blockZ[j] > 0) { const l = LOG(blockZ[j]); if (l > -70 && l > rel) { s2 += blockZ[j]; c2++; } }
      if (c2) { integrated = LOG(s2 / c2); gated = c2; }
    }
  }
  // short-term (3 s = 30 segments, step 100 ms) and loudness range
  const st = [];
  let shortTermMax = null;
  for (let j = 0; j + 30 <= segs; j++) {
    let e = 0;
    let l = 0;
    for (let q = j; q < j + 30; q++) { e += segE[q]; l += segLen[q]; }
    const z = e / l;
    if (z > 0) { const v = LOG(z); st.push(v); if (shortTermMax === null || v > shortTermMax) shortTermMax = v; }
    else st.push(-Infinity);
  }
  let lra = null;
  let lraLow = null;
  let lraHigh = null;
  const absG = st.filter((v) => v > -70);
  if (absG.length) {
    const mean = 10 * DM.log10(absG.reduce((s, v) => s + DM.pow(10, v / 10), 0) / absG.length);
    const g2 = absG.filter((v) => v > mean - 20).sort((a, b) => a - b);
    if (g2.length) { lraLow = percentile(g2, 0.1); lraHigh = percentile(g2, 0.95); lra = lraHigh - lraLow; }
  }
  const target = opts.target === undefined ? -23 : opts.target;
  const ceiling = opts.tpCeiling === undefined ? -1 : opts.tpCeiling;
  const tpDb = db(truePk);
  const gain = integrated === null ? null : target - integrated;
  const gainLim = gain === null ? null : tpDb === null ? gain : Math.min(gain, ceiling - tpDb);
  if (nonFinite) warnings.push('non_finite_samples');
  if (nBlocks === 0) warnings.push('shorter_than_block');
  return {
    integrated, momentaryMax, shortTermMax, lra, lraLow, lraHigh,
    truePeak: tpDb, samplePeak: db(samplePeak),
    gainToTarget: gain, gainToTargetPeakLimited: gainLim, target, tpCeiling: ceiling,
    blocks: nBlocks, gatedBlocks: gated, shortTermValues: st.length, nonFinite, weights: weights.slice(0, nch), warnings,
  };
}
