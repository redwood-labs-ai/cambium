/**
 * #200 (DEC-200-002 / DEC-200-008): unit tests for the deterministic
 * PNG → swatch-list pre-pass.
 *
 * The golden test for ThemePalette does NOT run this pre-pass (its
 * fixture is hand-authored — DEC-200-008); this file constructs a tiny
 * 8×8 two-color PNG in-code (raw scanlines + `node:zlib` deflate, no PNG
 * encoder needed) and proves the decoder + k-means come back with the
 * correct dominant swatches, deterministically.
 */
import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { extractSwatches, decodePng, kmeans16 } from '../examples/omarchy/extract-swatches.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The decoder deliberately doesn't validate the PNG CRC (see
// extract-swatches.mjs), so a dummy 4-byte trailer is fine here.
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

/** Build a minimal 8-bit non-interlaced truecolor RGB PNG in memory. */
function buildPng(width: number, height: number, colorAt: (x: number, y: number) => [number, number, number]): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3) // filter-type byte (None) + RGB pixels
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y)
      row[1 + x * 3] = r
      row[1 + x * 3 + 1] = g
      row[1 + x * 3 + 2] = b
    }
    rows.push(row)
  }
  const raw = Buffer.concat(rows)
  const idat = deflateSync(raw)

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(2, 9) // color type: truecolor RGB
  ihdr.writeUInt8(0, 10) // compression method
  ihdr.writeUInt8(0, 11) // filter method
  ihdr.writeUInt8(0, 12) // interlace method: none

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// Tokyo-Night-ish background/accent, 6 rows background (48px, 75%) and
// 2 rows accent (16px, 25%) over an 8×8 image.
const BACKGROUND: [number, number, number] = [0x1a, 0x1b, 0x26] // #1a1b26
const ACCENT: [number, number, number] = [0x7a, 0xa2, 0xf7] // #7aa2f7

describe('extract-swatches (DEC-200-002)', () => {
  it('decodes a hand-built 8×8 RGB PNG back to its exact pixels', () => {
    const png = buildPng(8, 8, (_x, y) => (y < 6 ? BACKGROUND : ACCENT))
    const { width, height, pixels } = decodePng(png)
    expect(width).toBe(8)
    expect(height).toBe(8)
    // First pixel is background, last pixel (bottom row) is accent.
    expect([pixels[0], pixels[1], pixels[2]]).toEqual(BACKGROUND)
    const lastPixelStart = (8 * 8 - 1) * 3
    expect([pixels[lastPixelStart], pixels[lastPixelStart + 1], pixels[lastPixelStart + 2]]).toEqual(ACCENT)
  })

  it('k-means recovers the two dominant swatches with correct shares', () => {
    const png = buildPng(8, 8, (_x, y) => (y < 6 ? BACKGROUND : ACCENT))
    const { pixels } = decodePng(png)
    const clusters = kmeans16(pixels)

    expect(clusters).toHaveLength(16)
    // Sorted descending by share.
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1].share).toBeGreaterThanOrEqual(clusters[i].share)
    }

    expect(clusters[0].share).toBeCloseTo(0.75, 6)
    expect(clusters[0].color).toEqual({ r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2] })
    expect(clusters[1].share).toBeCloseTo(0.25, 6)
    expect(clusters[1].color).toEqual({ r: ACCENT[0], g: ACCENT[1], b: ACCENT[2] })

    // The remaining 14 centroids (duplicates seeded from cycling a
    // 2-distinct-bin histogram) settle at zero share.
    const remainder = clusters.slice(2).reduce((sum, c) => sum + c.share, 0)
    expect(remainder).toBe(0)
  })

  it('extractSwatches emits the DEC-200-001 JSON contract', () => {
    const png = buildPng(8, 8, (_x, y) => (y < 6 ? BACKGROUND : ACCENT))
    const result = extractSwatches(png, 'fixture.png')

    expect(result.source).toBe('fixture.png')
    expect(result.k).toBe(16)
    expect(result.swatches).toHaveLength(16)

    // These are the exact values the DEC-200-001 formulas (WCAG 2.1
    // relative luminance; standard HSL hue/sat) produce for #1a1b26 /
    // #7aa2f7 — not the plan's illustrative example numbers, which were
    // hand-typed for a different (23-swatch, real-photo) palette.
    const [top, second] = result.swatches
    expect(top.hex).toBe('#1a1b26')
    expect(top.share).toBe(0.75)
    expect(top.hue).toBe(235)
    expect(top.sat).toBe(0.188)
    expect(top.luma).toBe(0.011)

    expect(second.hex).toBe('#7aa2f7')
    expect(second.share).toBe(0.25)
    expect(second.hue).toBe(220.8)
    expect(second.sat).toBe(0.887)
    expect(second.luma).toBe(0.367)

    // Every swatch matches the DEC-200-001 shape exactly.
    for (const swatch of result.swatches) {
      expect(Object.keys(swatch).sort()).toEqual(['hex', 'hue', 'luma', 'sat', 'share'])
      expect(swatch.hex).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('rejects a non-PNG file with a message naming the constraint', () => {
    const bogus = Buffer.from('not a png at all')
    expect(() => decodePng(bogus)).toThrow(/not a PNG file/)
  })

  // (AUD-002, round 1) Each IHDR clause of the combined unsupported-input
  // guard gets its own test, mutating only that byte, so a future
  // refactor that drops one clause fails exactly that test instead of
  // none. IHDR data starts at absolute offset 16 (8-byte signature +
  // 4-byte length + 4-byte "IHDR" type); within it: width(4) height(4)
  // bitDepth(1)@8 colorType(1)@9 compressionMethod(1)@10 filterMethod(1)@11
  // interlaceMethod(1)@12.
  const IHDR_DATA_OFFSET = 8 + 4 + 4
  const BIT_DEPTH_OFFSET = IHDR_DATA_OFFSET + 8
  const COLOR_TYPE_OFFSET = IHDR_DATA_OFFSET + 9
  const INTERLACE_METHOD_OFFSET = IHDR_DATA_OFFSET + 12

  it('rejects an indexed/palette PNG (color type 3) rather than silently misreading it', () => {
    const png = buildPng(2, 2, () => BACKGROUND)
    const mutated = Buffer.from(png)
    mutated[COLOR_TYPE_OFFSET] = 3 // indexed/palette
    expect(() => decodePng(mutated)).toThrow(/unsupported PNG/)
    expect(() => decodePng(mutated)).toThrow(/magick/)
  })

  it('rejects an interlaced PNG rather than silently misreading it', () => {
    const png = buildPng(2, 2, () => BACKGROUND)
    const mutated = Buffer.from(png)
    mutated[INTERLACE_METHOD_OFFSET] = 1 // Adam7 interlacing
    expect(() => decodePng(mutated)).toThrow(/unsupported PNG/)
    expect(() => decodePng(mutated)).toThrow(/magick/)
  })

  it('rejects a 16-bit PNG rather than silently misreading it', () => {
    const png = buildPng(2, 2, () => BACKGROUND)
    const mutated = Buffer.from(png)
    mutated[BIT_DEPTH_OFFSET] = 16
    expect(() => decodePng(mutated)).toThrow(/unsupported PNG/)
    expect(() => decodePng(mutated)).toThrow(/magick/)
  })
})
