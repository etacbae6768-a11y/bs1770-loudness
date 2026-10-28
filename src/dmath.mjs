// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Park Jihoon (Tools That Don't Upload). https://toolsthatdontupload.com
// Deterministic elementary functions for the audio tools.
//
// ECMAScript fixes the results of + - * / (IEEE-754, round to nearest) and in practice sqrt (every
// engine uses the correctly rounded hardware instruction), but Math.sin / cos / tan / exp / log /
// log10 / log2 / pow are "implementation-approximated": Node and Chromium return results that differ
// by one ulp for some arguments, which breaks byte-identical outputs across runtimes (DoD G6).
// Everything below uses only those exact operations plus bit manipulation through a DataView, so every
// runtime computes the same bits. Accuracy is about one ulp (the tool tests compare against Math.*).
//
// Methods (textbook): exp by reduction x = k ln2 + r, |r| <= ln2/2, and the Taylor series of e^r;
// log by x = m 2^e, m in [sqrt(1/2), sqrt(2)], log m = 2 atanh(s) with s = (m - 1) / (m + 1);
// sin / cos by reduction modulo pi/2 with an exact (Dekker) product k * (pi/2 high part) and Taylor
// series on |r| <= pi/4; pow by exp(y log x), integer exponents by binary powering.

const DV = new DataView(new ArrayBuffer(8));

/** Exact 2^k for integer k (subnormal results included, 0 / Infinity outside the range). */
export function pow2i(k) {
  if (k > 1023) return Infinity;
  if (k >= -1022) {
    DV.setUint32(0, (k + 1023) * 1048576);
    DV.setUint32(4, 0);
    return DV.getFloat64(0);
  }
  if (k < -1074) return 0;
  return pow2i(k + 600) * pow2i(-600); // exact: the product is a representable subnormal
}

/** p * 2^k without intermediate overflow / underflow for k in [-2100, 2100]. */
function scale(p, k) {
  if (k > 1023) return p * pow2i(1023) * pow2i(k - 1023);
  if (k < -1021) return p * pow2i(k + 900) * pow2i(-900);
  return p * pow2i(k);
}

// ln 2 = 0.693147180559945309417232121458176568...; Math.LN2 is the nearest double, the rest of the
// constant (ln 2 - Math.LN2) is 2.3190468138462996e-17. LN2_HI keeps the top 21 significant bits so
// that k * LN2_HI is exact for every |k| < 2^32.
const LN2_HI = (() => { DV.setFloat64(0, Math.LN2); DV.setUint32(4, 0); return DV.getFloat64(0); })();
const LN2_LO = (Math.LN2 - LN2_HI) + 2.3190468138462996e-17;
const INV_LN2 = 1 / Math.LN2;
const INV_LN10 = 1 / Math.LN10;

const EXP_T = (() => { const t = [1]; let f = 1; for (let i = 1; i <= 15; i++) { f /= i; t.push(f); } return t; })();

/** e^x */
export function exp(x) {
  if (x !== x) return x;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  let p = EXP_T[15];
  for (let i = 14; i >= 0; i--) p = p * r + EXP_T[i];
  return k === 0 ? p : scale(p, k);
}

// log(1 + f) = f - s (f - R), s = f / (2 + f), R = 2/3 s^2 + 2/5 s^4 + ... (|s| <= 0.1716)
const LOG_R = (() => { const t = []; for (let i = 1; i <= 12; i++) t.push(2 / (2 * i + 1)); return t; })();

/** natural logarithm */
export function log(x) {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  DV.setFloat64(0, x);
  let hi = DV.getUint32(0);
  if (hi < 0x00100000) { // subnormal: scale into the normal range first (exact)
    x *= pow2i(64);
    e = -64;
    DV.setFloat64(0, x);
    hi = DV.getUint32(0);
  }
  e += ((hi >>> 20) & 0x7ff) - 1023;
  DV.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = DV.getFloat64(0); // [1, 2)
  if (m > Math.SQRT2) { m *= 0.5; e += 1; }
  const f = m - 1; // exact (Sterbenz)
  if (f === 0) return e === 0 ? 0 : e * LN2_HI + e * LN2_LO;
  const s = f / (2 + f);
  const z = s * s;
  let R = LOG_R[11];
  for (let i = 10; i >= 0; i--) R = R * z + LOG_R[i];
  R *= z;
  const lm = f - s * (f - R);
  return e === 0 ? lm : e * LN2_HI + (e * LN2_LO + lm);
}

/** log base 10 */
export function log10(x) { return log(x) * INV_LN10; }

/** log base 2 (exact for exact powers of two) */
export function log2(x) {
  if (x > 0 && x !== Infinity) {
    DV.setFloat64(0, x);
    if (DV.getUint32(4) === 0 && (DV.getUint32(0) & 0x000fffff) === 0 && DV.getUint32(0) >= 0x00100000) return ((DV.getUint32(0) >>> 20) & 0x7ff) - 1023;
  }
  return log(x) * INV_LN2;
}

function powInt(x, n) {
  let r = 1;
  let b = x;
  while (n > 0) {
    if (n & 1) r *= b;
    n = Math.floor(n / 2);
    if (n) b *= b;
  }
  return r;
}

/** x^y (real result; NaN for a negative base with a non-integer exponent) */
export function pow(x, y) {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  if (x === 2 && Number.isInteger(y)) return pow2i(y);
  if (Number.isInteger(y) && Math.abs(y) <= 4096) {
    const r = powInt(x, Math.abs(y));
    return y < 0 ? 1 / r : r;
  }
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x === Infinity) return y > 0 ? Infinity : 0;
  if (x < 0) {
    if (!Number.isInteger(y)) return NaN;
    const r = exp(y * log(-x));
    return Math.abs(y) % 2 === 1 ? -r : r;
  }
  if (y === 0.5) return Math.sqrt(x);
  if (y === 0.25) return Math.sqrt(Math.sqrt(x));
  if (y === 0.75) return Math.sqrt(x * Math.sqrt(x));
  return exp(y * log(x));
}

const Q4 = [1, Math.sqrt(Math.SQRT2), Math.SQRT2, Math.SQRT2 * Math.sqrt(Math.SQRT2)];
/** 2^(n/4) for integer n (MPEG quantiser steps): exact for multiples of 4. */
export function pow2q(n) {
  const k = Math.floor(n / 4);
  return Q4[n - 4 * k] * pow2i(k);
}

/** 10^(x/20) (dB to amplitude) */
export function dbToGain(db) { return exp(db * (Math.LN10 / 20)); }

/** 10^x */
export function pow10(x) { return Number.isInteger(x) && x >= 0 && x <= 22 ? powInt(10, x) : exp(x * Math.LN10); }

const P16 = (() => { const t = [1]; for (let j = 1; j < 16; j++) t.push(exp((j / 16) * Math.LN2)); return t; })();
/** 2^x (exact for integers, table based for multiples of 1/16) */
export function pow2(x) {
  if (Number.isInteger(x)) return pow2i(x);
  const t = x * 16;
  if (Number.isInteger(t)) { const k = Math.floor(t / 16); return P16[t - 16 * k] * pow2i(k); }
  return exp(x * Math.LN2);
}

/** cube root (one Newton step from exp(log(x) / 3); exact for perfect cubes of small integers) */
export function cbrt(x) {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
  if (x < 0) return -cbrt(-x);
  let y = exp(log(x) / 3);
  y -= (y * y * y - x) / (3 * y * y);
  const r = Math.round(y);
  return r * r * r === x ? r : y;
}

// pi/2 = 1.5707963267948966192313216916397514420985...; Math.PI / 2 is exact (halving) and the rest of
// the constant (pi/2 - Math.PI/2) is 6.123233995736766e-17.
const PIO2_HI = Math.PI / 2;
const PIO2_LO = 6.123233995736766e-17;
const TWO_OVER_PI = 2 / Math.PI;
const SPLIT = 134217729; // 2^27 + 1 (Veltkamp split)
const PH_C = SPLIT * PIO2_HI;
const PIH = PH_C - (PH_C - PIO2_HI);
const PIL = PIO2_HI - PIH;
const SIN_T = (() => { const t = []; let f = 1; for (let i = 1; i <= 19; i++) { f /= i; if (i % 2 === 1 && i > 1) t.push(((i - 1) / 2) % 2 ? -f : f); } return t; })(); // -1/3!, 1/5!, ...
const COS_T = (() => { const t = []; let f = 1; for (let i = 1; i <= 20; i++) { f /= i; if (i % 2 === 0) t.push((i / 2) % 2 ? -f : f); } return t; })(); // -1/2!, 1/4!, ...
let RED_K = 0;

/** r = x - k pi/2 with |r| <= pi/4 (plus rounding); sets RED_K = k */
function reduce(x) {
  if (x > -0.7853981633974483 && x < 0.7853981633974483) { RED_K = 0; return x; }
  const k = Math.round(x * TWO_OVER_PI);
  // exact product k * PIO2_HI = ph + pl (Dekker), then subtract k * PIO2_LO
  const ph = k * PIO2_HI;
  const kc = SPLIT * k;
  const kh = kc - (kc - k);
  const kl = k - kh;
  const pl = ((kh * PIH - ph) + kh * PIL + kl * PIH) + kl * PIL;
  RED_K = k;
  return ((x - ph) - pl) - k * PIO2_LO;
}
function sinPoly(r) {
  const z = r * r;
  let p = SIN_T[SIN_T.length - 1];
  for (let i = SIN_T.length - 2; i >= 0; i--) p = p * z + SIN_T[i];
  return r + r * z * p;
}
function cosPoly(r) {
  const z = r * r;
  let p = COS_T[COS_T.length - 1];
  for (let i = COS_T.length - 2; i >= 0; i--) p = p * z + COS_T[i];
  return 1 + z * p;
}

/** sine */
export function sin(x) {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const r = reduce(x);
  const q = ((RED_K % 4) + 4) % 4;
  if (q === 0) return sinPoly(r);
  if (q === 1) return cosPoly(r);
  if (q === 2) return -sinPoly(r);
  return -cosPoly(r);
}

/** cosine */
export function cos(x) {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const r = reduce(x);
  const q = ((RED_K % 4) + 4) % 4;
  if (q === 0) return cosPoly(r);
  if (q === 1) return -sinPoly(r);
  if (q === 2) return -cosPoly(r);
  return sinPoly(r);
}

/** tangent */
export function tan(x) { return sin(x) / cos(x); }

/** arctangent (argument reduction to |t| <= tan(pi/12), then the Taylor series) */
export function atan(x) {
  if (x !== x) return x;
  if (x < 0) return -atan(-x);
  if (x === Infinity) return PIO2_HI;
  if (x > 1) return (PIO2_HI - atan(1 / x)) + PIO2_LO;
  // atan x = pi/6 + atan((x - c) / (1 + c x)), c = tan(pi/6) = 1/sqrt(3), for x > 2 - sqrt(3)
  if (x > 0.2679491924311227) { const c = 1 / Math.sqrt(3); return Math.PI / 6 + atan((x - c) / (1 + c * x)); }
  // x + x z (c1 + c2 z + ...), c_i = (-1)^i / (2i + 1), z = x^2 <= 0.0718
  const z = x * x;
  let p = 0;
  for (let i = 18; i >= 1; i--) p = p * z + (i % 2 ? -1 : 1) / (2 * i + 1);
  return x + x * z * p;
}

/** sin(pi x) / (pi x) */
export function sinc(x) {
  if (x === 0) return 1;
  const a = Math.PI * x;
  return sin(a) / a;
}

/** Bessel I0 by its power series (all terms positive: deterministic and accurate). */
export function besselI0(x) {
  const h = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 500; k++) {
    term *= h / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}
