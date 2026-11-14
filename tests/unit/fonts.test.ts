// The web IDE's font converter (src/fonts/rasterise.ts) against the references of
// scripts/fonts.py: LVGL's own Montserrat, which lv_font_conv made from the same TrueType file,
// with the parity upstream's tests/test_fonts.py asks of fontconv.py; and fontconv.py itself.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type FreeType,
  type Glyph,
  type RasterFont,
  rasterise,
} from '../../src/fonts/rasterise.ts';

const require = createRequire(import.meta.url);
const FIXTURES = new URL('../fixtures/fonts/', import.meta.url);
const TTF = new Uint8Array(readFileSync(new URL('Montserrat-Medium.ttf', FIXTURES)));
const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('');

interface Reference {
  lvgl: { glyphs: Glyph[]; kerning: Record<string, number> };
  fontconv: RasterFont & { missing: string };
}

let ft: FreeType;

beforeAll(async () => {
  const factory =
    require('lv_font_conv/lib/freetype/build/ft_render.js') as () => Promise<FreeType>;
  ft = await factory();
});

const metrics = (glyph: Glyph) => [
  glyph.advance,
  glyph.width,
  glyph.height,
  glyph.ofs_x,
  glyph.ofs_y,
];

describe.each([14, 24, 40])('Montserrat at %i px', (size) => {
  const reference = JSON.parse(
    readFileSync(new URL(`montserrat-${size}.json`, FIXTURES), 'utf-8'),
  ) as Reference;

  it("has LVGL's metrics and pixels, within upstream's parity", () => {
    const { font, missing } = rasterise(ft, TTF, size, ASCII);
    expect(missing).toBe('');
    let pixels = 0;
    let different = 0;
    for (const glyph of font.glyphs) {
      const expected = reference.lvgl.glyphs.find((item) => item.code === glyph.code);
      if (!expected) throw new Error(String(glyph.code));
      expect(metrics(glyph), String.fromCharCode(glyph.code)).toEqual(metrics(expected));
      glyph.pixels.forEach((value, index) => {
        const theirs = expected.pixels[index] ?? 0;
        expect(Math.abs(value - theirs)).toBeLessThanOrEqual(1);
        if (value !== theirs) different++;
      });
      pixels += expected.pixels.length;
    }
    // upstream's test asks fewer than two in a thousand; its docstring says under one in a thousand
    expect(different / pixels).toBeLessThan(0.002);
    console.info(`${size} px: ${different} of ${pixels} pixels one level apart from LVGL's`);
  });

  it("kerns every pair LVGL's font kerns, with its values", () => {
    const { font } = rasterise(ft, TTF, size, ASCII);
    const lvgl = reference.lvgl.kerning;
    expect(Object.keys(lvgl).length).toBeGreaterThan(2000);
    const mine = Object.fromEntries(Object.keys(lvgl).map((pair) => [pair, font.kerning[pair]]));
    expect(mine).toEqual(lvgl);
    const extra = Object.keys(font.kerning).filter((pair) => !(pair in lvgl)).length;
    // as fontconv.py: the pairs HarfBuzz finds besides LVGL's, with the same values
    expect(font.kerning).toEqual(reference.fontconv.kerning);
    const qt = Object.keys(reference.fontconv.kerning).length;
    console.info(
      `${size} px: ${Object.keys(font.kerning).length} pairs kerned (LVGL ${Object.keys(lvgl).length}, ${extra} more; fontconv.py ${qt})`,
    );
  });

  it('compares with fontconv.py: metrics, pixels, kerning, underline', () => {
    const { font } = rasterise(ft, TTF, size, ASCII);
    const qt = reference.fontconv;
    let metricsSame = 0;
    let pixels = 0;
    let different = 0;
    let far = 0;
    for (const glyph of font.glyphs) {
      const theirs = qt.glyphs.find((item) => item.code === glyph.code);
      if (!theirs) continue;
      if (metrics(glyph).join() === metrics(theirs).join()) {
        metricsSame++;
        glyph.pixels.forEach((value, index) => {
          const other = theirs.pixels[index] ?? 0;
          if (value !== other) different++;
          if (Math.abs(value - other) > 1) far++;
        });
        pixels += glyph.pixels.length;
      }
    }
    const pairs = new Set([...Object.keys(font.kerning), ...Object.keys(qt.kerning)]);
    const kerningSame = [...pairs].filter((pair) => font.kerning[pair] === qt.kerning[pair]).length;
    console.info(
      `${size} px against fontconv.py: metrics the same on ${metricsSame} of ${font.glyphs.length} glyphs; ` +
        `pixels: ${different} of ${pixels} differ, ${far} by more than one level; ` +
        `kerning the same on ${kerningSame} of ${pairs.size} pairs; underline ${font.underline_position}/${font.underline_thickness} against ${qt.underline_position}/${qt.underline_thickness}`,
    );
    expect(metricsSame).toBe(font.glyphs.length);
    expect(far).toBe(0);
    expect(different / pixels).toBeLessThan(0.0001);
    expect([font.underline_position, font.underline_thickness]).toEqual([
      qt.underline_position,
      qt.underline_thickness,
    ]);
  });
});
