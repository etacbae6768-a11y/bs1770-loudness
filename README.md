# bs1770-loudness

Loudness and true-peak measurement in plain JavaScript, following ITU-R BS.1770 and EBU R 128.
No dependencies, no WebAssembly, no build step. Works in Node.js and in the browser.

It is the measurement code behind the free [online loudness meter](https://freesoundtools.com/en/tools/loudness/)
on FreeSoundTools, part of [Tools That Don't Upload](https://toolsthatdontupload.com/), where audio is
measured in the browser and never uploaded.

## What it measures

| Value | Standard |
|---|---|
| Integrated loudness (LUFS), gated | ITU-R BS.1770-4: K-weighting, 400 ms blocks with 75 % overlap, absolute gate -70 LUFS, relative gate -10 LU |
| Momentary max (400 ms) and short-term max (3 s) | EBU Tech 3341 |
| Loudness range (LRA) | EBU Tech 3342: short-term values, -70 LUFS absolute and -20 LU relative gates, 10th to 95th percentile |
| True peak (dBTP) | BS.1770 Annex 2 approach: 4x or more oversampling with a windowed-sinc interpolator |
| Sample peak (dBFS) | |
| Gain to a target, with and without a true-peak ceiling | EBU R 128 target -23 LUFS by default |

Channel weights follow BS.1770: 1.0 for front channels, 1.41 for surrounds, LFE excluded (5.1 order L, R, C, LFE, Ls, Rs).
Any sample rate from 8 kHz to 384 kHz: the 48 kHz filters are mapped to an analogue prototype and re-discretised.

## Usage

```js
import { measureLoudness } from './index.mjs';

// channels: one Float32Array (or Float64Array) per channel, full scale = 1.0
const r = measureLoudness([left, right], 48000);
console.log(r.integrated, r.lra, r.truePeak);   // e.g. -23.0  5.2  -1.4
```

In the browser you can get the channels from the Web Audio API:

```js
const buf = await new AudioContext().decodeAudioData(await file.arrayBuffer());
const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const r = measureLoudness(chans, buf.sampleRate);
```

### `measureLoudness(channels, sampleRate, options?)`

Options: `{ weights, channelMask, target = -23, tpCeiling = -1, checkpoint }`.

Returns plain JSON-safe values. A value that cannot be measured is `null`, never `NaN`
(for example the integrated loudness of silence or of input shorter than one 400 ms block):

`{ integrated, momentaryMax, shortTermMax, lra, lraLow, lraHigh, truePeak, samplePeak,
gainToTarget, gainToTargetPeakLimited, blocks, gatedBlocks, shortTermValues, nonFinite, warnings }`

Non-finite samples count as silence (warning `non_finite_samples`). Channels of different length are
measured over the shortest one (warning `channel_length_mismatch`). A missing channel list or an
unsupported sample rate throws `LoudnessError` (`code: 'invalid_input'`, `details.reason`).

Also exported: `truePeak(samples, sampleRate)`, `kWeighting(sampleRate)`, `channelWeights(n, mask)`.

## Conformance

`node --test` runs the checks in `test/`:

- EBU Tech 3341 integrated-loudness cases 1 to 5, within +-0.1 LU
- EBU Tech 3342 loudness-range cases 1 to 4, within +-1 LU
- true peak of sines whose peaks fall between samples (12 kHz, 11.025 kHz, 9 kHz, 997 Hz), within 0.2 dB
- 44.1 kHz input, silence, input shorter than one block, invalid sample rate

The test signals are generated in the test file from the descriptions in the EBU documents.

## Deterministic results

`src/dmath.mjs` implements the elementary functions (log, exp, sin, ...) with exact IEEE-754
operations only, so the same input gives bit-identical results in Node.js and in browsers, whose
built-in `Math.log` and friends can differ in the last digit.

## License

MIT. Written from the published standards; no code from other loudness libraries was used.
