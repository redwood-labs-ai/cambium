#!/usr/bin/env node
// #200 (DEC-200-002): deterministic PNG → swatch-list pre-pass.
//
// No new deps: PNG decode uses only `node:zlib` (inflate) + hand-rolled
// scanline unfiltering; k-means is seeded from a fixed pixel histogram
// instead of a PRNG, so a given input PNG always produces the same
// output JSON. Emits the DEC-200-001 swatch-contract JSON on stdout:
//
//   { "source": "<file>", "k": 16, "swatches": [ { hex, share, luma, hue, sat }, ... ] }
//
// Supported input: 8-bit, non-interlaced, truecolor PNG (color type 2
// RGB or 6 RGBA). Anything else (palette PNGs, 16-bit, interlaced,
// JPEG/WebP/...) exits with an error naming the constraint — convert
// first, e.g. `magick in.jpg out.png`.
//
// Usage: node extract-swatches.mjs <path/to/image.png>

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const K = 16;
// Merge threshold for near-duplicate centroids, in 0-255 RGB units
// (Euclidean distance across the three channels).
const MERGE_EPSILON = 6;
const MAX_LLOYD_ITERATIONS = 20;

class UnsupportedPngError extends Error {}

// ── PNG decode ──────────────────────────────────────────────────────

/**
 * Parse a PNG buffer into { width, height, pixels } where `pixels` is a
 * flat Uint8ClampedArray of RGB triples (alpha, if present, is dropped —
 * dominant-color extraction only needs visible color).
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new UnsupportedPngError('extract-swatches: not a PNG file (bad signature).');
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + length);
    // 4-byte CRC follows; we don't validate it (nothing downstream of
    // this script trusts the PNG as anything but a local rendering
    // input, and skipping CRC keeps the decoder — and its test
    // fixtures — a lot smaller).
    offset = dataStart + length + 4;

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        compressionMethod: data.readUInt8(10),
        filterMethod: data.readUInt8(11),
        interlaceMethod: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) {
    throw new UnsupportedPngError('extract-swatches: PNG has no IHDR chunk.');
  }
  const { width, height, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod } = ihdr;
  const supportedColorType = colorType === 2 || colorType === 6; // RGB or RGBA
  if (bitDepth !== 8 || !supportedColorType || compressionMethod !== 0 || filterMethod !== 0 || interlaceMethod !== 0) {
    throw new UnsupportedPngError(
      `extract-swatches: unsupported PNG (bit depth ${bitDepth}, color type ${colorType}, interlace ${interlaceMethod}) — ` +
      `only 8-bit non-interlaced truecolor RGB/RGBA is supported. Convert first, e.g. \`magick in.jpg out.png\`.`,
    );
  }
  if (idatChunks.length === 0) {
    throw new UnsupportedPngError('extract-swatches: PNG has no IDAT data.');
  }

  const bpp = colorType === 6 ? 4 : 3; // bytes per pixel (8-bit RGB / RGBA)
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatChunks));

  // PNG scanline unfiltering (RFC 2083 §6): each row is prefixed with a
  // filter-type byte; reconstruction reads left (a), up (b), and
  // up-left (c) neighbors from already-unfiltered bytes.
  const unfiltered = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const srcStart = y * (stride + 1) + 1;
    const dstStart = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[srcStart + i];
      const a = i >= bpp ? unfiltered[dstStart + i - bpp] : 0;
      const b = y > 0 ? unfiltered[dstStart - stride + i] : 0;
      const c = y > 0 && i >= bpp ? unfiltered[dstStart - stride + i - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = x; break; // None
        case 1: value = x + a; break; // Sub
        case 2: value = x + b; break; // Up
        case 3: value = x + Math.floor((a + b) / 2); break; // Average
        case 4: value = x + paethPredictor(a, b, c); break; // Paeth
        default:
          throw new UnsupportedPngError(`extract-swatches: unknown PNG filter type ${filterType} at row ${y}.`);
      }
      unfiltered[dstStart + i] = value & 0xff;
    }
  }

  // Drop alpha (if present) — extraction only needs visible RGB.
  const pixels = new Uint8ClampedArray(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const srcIdx = p * bpp;
    const dstIdx = p * 3;
    pixels[dstIdx] = unfiltered[srcIdx];
    pixels[dstIdx + 1] = unfiltered[srcIdx + 1];
    pixels[dstIdx + 2] = unfiltered[srcIdx + 2];
  }

  return { width, height, pixels };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ── Deterministic k-means (histogram-seeded, no PRNG) ──────────────

/**
 * Build a 5-bit/channel histogram: { binKey → { count, sumR, sumG, sumB } }.
 */
function buildHistogram(pixels) {
  const histogram = new Map();
  for (let p = 0; p < pixels.length; p += 3) {
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    const binKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bin = histogram.get(binKey);
    if (bin) {
      bin.count += 1; bin.sumR += r; bin.sumG += g; bin.sumB += b;
    } else {
      histogram.set(binKey, { count: 1, sumR: r, sumG: g, sumB: b });
    }
  }
  return histogram;
}

function binAverage(bin) {
  return { r: bin.sumR / bin.count, g: bin.sumG / bin.count, b: bin.sumB / bin.count };
}

function rgbDistance(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function nearestCentroidIndex(color, centroids) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = rgbDistance(color, centroids[i]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Deterministic k-means over the pixel histogram (k=16, fixed by
 * DEC-200-001). Seeded from the top-K distinct histogram bins by count
 * (ties broken by ascending bin key) instead of a random init; Lloyd's
 * iterations run in fixed bin order and stop early on convergence,
 * capped at MAX_LLOYD_ITERATIONS. After convergence, centroids closer
 * than MERGE_EPSILON are merged and the freed slot is refilled from the
 * next-ranked unused bin (if any), then every bin is re-settled against
 * the final centroids to compute exact pixel shares.
 */
export function kmeans16(pixels) {
  const histogram = buildHistogram(pixels);
  const ranked = [...histogram.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);
  const totalPixels = pixels.length / 3;

  // Seed initial centroids from the top-K distinct bins. If the image
  // has fewer than K distinct 5-bit bins (tiny/flat fixtures), cycle
  // through the ranked list so we still start with K centroids —
  // duplicates converge onto the same color and settle at share 0,
  // which keeps the output contract (exactly K swatches) intact.
  let centroids = [];
  for (let i = 0; i < K; i++) {
    centroids.push(binAverage(ranked[i % ranked.length][1]));
  }
  let nextRefillRank = Math.min(K, ranked.length);

  let assignment = new Array(ranked.length).fill(-1);
  for (let iter = 0; iter < MAX_LLOYD_ITERATIONS; iter++) {
    let changed = false;
    const newAssignment = ranked.map(([, bin]) => nearestCentroidIndex(binAverage(bin), centroids));
    for (let i = 0; i < ranked.length; i++) {
      if (newAssignment[i] !== assignment[i]) { changed = true; break; }
    }
    assignment = newAssignment;

    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (let i = 0; i < ranked.length; i++) {
      const [, bin] = ranked[i];
      const s = sums[assignment[i]];
      s.r += bin.sumR; s.g += bin.sumG; s.b += bin.sumB; s.count += bin.count;
    }
    centroids = centroids.map((old, i) => (sums[i].count > 0 ? { r: sums[i].r / sums[i].count, g: sums[i].g / sums[i].count, b: sums[i].b / sums[i].count } : old));

    if (!changed) break;
  }

  // Merge near-duplicate centroids; refill freed slots from the next
  // unused ranked bin, in fixed (ascending centroid index) order.
  for (let i = 1; i < centroids.length; i++) {
    for (let j = 0; j < i; j++) {
      if (rgbDistance(centroids[i], centroids[j]) < MERGE_EPSILON) {
        if (nextRefillRank < ranked.length) {
          centroids[i] = binAverage(ranked[nextRefillRank][1]);
          nextRefillRank += 1;
        }
        break;
      }
    }
  }

  // Final settle: assign every bin to the nearest final centroid and
  // accumulate exact shares/colors from that assignment.
  const totals = centroids.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
  for (const [, bin] of ranked) {
    const idx = nearestCentroidIndex(binAverage(bin), centroids);
    const t = totals[idx];
    t.r += bin.sumR; t.g += bin.sumG; t.b += bin.sumB; t.count += bin.count;
  }

  return centroids
    .map((centroid, i) => {
      const t = totals[i];
      const color = t.count > 0 ? { r: t.r / t.count, g: t.g / t.count, b: t.b / t.count } : centroid;
      return { color, share: totalPixels > 0 ? t.count / totalPixels : 0 };
    })
    .sort((a, b) => b.share - a.share);
}

// ── Colour math (DEC-200-001) ───────────────────────────────────────

function toHex(color) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const channel = (v) => clamp(v).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

// WCAG 2.1 relative luminance.
function relativeLuminance(color) {
  const linearize = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = linearize(color.r), g = linearize(color.g), b = linearize(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// HSL hue [0, 360) and saturation [0, 1]. Lightness is deliberately not
// returned (DEC-200-001: `luma` is the single darkness axis).
function hueSat(color) {
  const r = color.r / 255, g = color.g / 255, b = color.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, sat: 0 };

  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;

  const lightness = (max + min) / 2;
  const sat = delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, sat };
}

function round(value, dp) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Turn k-means clusters into DEC-200-001-shaped swatches: sorted by
 * share descending, share/luma rounded to 3dp, hue to 1dp, sat to 3dp.
 */
export function clustersToSwatches(clusters) {
  return clusters
    .map(({ color, share }) => {
      const { hue, sat } = hueSat(color);
      return {
        hex: toHex(color),
        share: round(share, 3),
        luma: round(relativeLuminance(color), 3),
        hue: round(hue, 1),
        sat: round(sat, 3),
      };
    })
    .sort((a, b) => b.share - a.share);
}

/**
 * Full pipeline: PNG buffer → DEC-200-001 JSON object.
 */
export function extractSwatches(pngBuffer, source) {
  const { pixels } = decodePng(pngBuffer);
  const clusters = kmeans16(pixels);
  return {
    source,
    k: K,
    swatches: clustersToSwatches(clusters),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node extract-swatches.mjs <path/to/image.png>');
    process.exit(2);
  }
  let buf;
  try {
    buf = readFileSync(inputPath);
  } catch (err) {
    console.error(`extract-swatches: could not read "${inputPath}": ${err.message}`);
    process.exit(1);
  }
  try {
    const result = extractSwatches(buf, basename(inputPath));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
