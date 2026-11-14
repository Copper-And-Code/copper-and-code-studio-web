// The rasteriser of upstream's lvgl_mpy_studio/fontconv.py, which is Qt, done with what LVGL's own
// converter uses: FreeType in WebAssembly as lv_font_conv 1.5.3 builds it (its
// lib/freetype/build/ft_render.js, rendering as its lib/freetype/index.js does), and opentype.js
// for kerning, as its lib/collect_font_data.js. The result has the shape of fontconv.rasterise,
// for upstream's gen/binfont.py write_binfont. No DOM: it runs in a worker and under Node.
import { parse as parseFont } from 'opentype.js';

/** The emscripten module of ft_render.js, with what this file uses of it. */
export interface FreeType {
  _init_constants(): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  cwrap(name: string, returns: string, args: string[]): (...values: number[]) => number;
  ccall(name: string, returns: string, types: string[], values: number[]): number;
  getValue(pointer: number, type: string): number;
  writeArrayToMemory(data: Uint8Array, pointer: number): void;
  [constant: string]: unknown;
}

export interface Glyph {
  code: number;
  /** In 1/16 pixel. */
  advance: number;
  width: number;
  height: number;
  ofs_x: number;
  ofs_y: number;
  /** One byte per pixel, 0..15. */
  pixels: number[];
}

export interface RasterFont {
  size: number;
  underline_position: number;
  underline_thickness: number;
  glyphs: Glyph[];
  /** "code,next code" → change of the advance in 1/16 pixel. */
  kerning: Record<string, number>;
}

const BITS_PER_PIXEL = 4;

const fixed1616 = (value: number) => value / 65536;

/**
 * fontconv.rasterise: the glyphs of the characters at size pixels, and the characters the font
 * has no glyph for. The glyphs are rendered as lv_font_conv renders them (light autohinting).
 */
export function rasterise(
  ft: FreeType,
  data: Uint8Array,
  size: number,
  characters: string,
): { font: RasterFont; missing: string } {
  ft._init_constants();
  const c = (name: string) => ft[name] as number;
  const newFace = ft.cwrap('FT_New_Memory_Face', 'number', [
    'number',
    'number',
    'number',
    'number',
    'number',
  ]);
  const setCharSize = ft.cwrap('FT_Set_Char_Size', 'number', [
    'number',
    'number',
    'number',
    'number',
    'number',
  ]);
  const setPixelSizes = ft.cwrap('FT_Set_Pixel_Sizes', 'number', ['number', 'number', 'number']);
  const charIndex = ft.cwrap('FT_Get_Char_Index', 'number', ['number', 'number']);
  const loadGlyph = ft.cwrap('FT_Load_Glyph', 'number', ['number', 'number', 'number']);
  const doneFace = ft.cwrap('FT_Done_Face', 'number', ['number']);

  let opentype: ReturnType<typeof parseFont>;
  try {
    opentype = parseFont(new Uint8Array(data).buffer);
  } catch {
    throw new Error('not a TrueType or OpenType font this program can read');
  }

  const pointer = ft._malloc(4);
  let library = 0;
  let face = 0;
  const memory = ft._malloc(data.length);
  try {
    if (ft.ccall('FT_Init_FreeType', 'number', ['number'], [pointer]))
      throw new Error('FreeType cannot start');
    library = ft.getValue(pointer, 'i32');
    ft.writeArrayToMemory(data, memory);
    if (newFace(library, memory, data.length, 0, pointer))
      throw new Error('not a TrueType or OpenType font this program can read');
    face = ft.getValue(pointer, 'i32');
    if (setCharSize(face, 0, size * 64, 300, 300) || setPixelSizes(face, 0, size))
      throw new Error('the font cannot be drawn at this size');

    const glyphs: Glyph[] = [];
    let missing = '';
    const flags = c('FT_LOAD_RENDER') | c('FT_LOAD_TARGET_LIGHT') | c('FT_LOAD_FORCE_AUTOHINT');
    for (const char of new Set(characters)) {
      if ([...char].length !== 1) continue;
      const code = char.codePointAt(0) ?? 0;
      const index = charIndex(face, code);
      if (!index) {
        missing += char;
        continue;
      }
      if (loadGlyph(face, index, flags)) {
        missing += char;
        continue;
      }
      const slot = ft.getValue(face + c('OFFSET_FACE_GLYPH'), 'i32');
      const width = ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_WIDTH'), 'i32');
      const height = ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_ROWS'), 'i32');
      const pitch = Math.abs(ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_PITCH'), 'i32'));
      const left = ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_LEFT'), 'i32');
      const top = ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_TOP'), 'i32');
      const buffer = ft.getValue(slot + c('OFFSET_GLYPH_BITMAP_BUFFER'), 'i32');
      // the advance as the font holds it, unhinted: as fontconv's design advance
      const linear = fixed1616(ft.getValue(slot + c('OFFSET_GLYPH_LINEAR_HORI_ADVANCE'), 'i32'));
      const pixels: number[] = [];
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const value = ft.getValue(buffer + row * pitch + column, 'i8') & 0xff;
          pixels.push(value >> (8 - BITS_PER_PIXEL)); // as lv_font_conv and fontconv: the top bits
        }
      }
      const empty = !width || !height;
      glyphs.push({
        code,
        advance: Math.floor(linear * 16 + 0.5),
        width: empty ? 0 : width,
        height: empty ? 0 : height,
        ofs_x: empty ? 0 : left,
        ofs_y: empty ? 0 : top - height,
        pixels: empty ? [] : pixels,
      });
    }
    // kerning, in 1/16 pixel: as fontconv.py has it from HarfBuzz, every pair lookup of the
    // font's kern feature added up; a font with only a kern table, as opentype.js reads it
    const kerning: Record<string, number> = {};
    const scale = size / opentype.unitsPerEm;
    const pairValue = pairKerning(opentype);
    const indexes = new Map(
      glyphs.map((glyph) => [
        glyph.code,
        opentype.charToGlyphIndex(String.fromCodePoint(glyph.code)),
      ]),
    );
    for (const first of glyphs) {
      const left = indexes.get(first.code) ?? 0;
      for (const second of glyphs) {
        const right = indexes.get(second.code) ?? 0;
        const value = Math.round(pairValue(left, right) * scale * 16);
        if (value) kerning[`${first.code},${second.code}`] = value;
      }
    }
    const post = opentype.tables.post as { underlinePosition: number; underlineThickness: number };
    return {
      font: {
        size,
        underline_position: Math.round(post.underlinePosition * scale),
        underline_thickness: Math.max(1, Math.round(post.underlineThickness * scale)),
        glyphs,
        kerning,
      },
      missing,
    };
  } finally {
    if (face) doneFace(face);
    if (library) ft.ccall('FT_Done_FreeType', 'number', ['number'], [library]);
    ft._free(memory);
    ft._free(pointer);
  }
}

type OpenTypeFont = ReturnType<typeof parseFont>;

interface PairSubtable {
  posFormat: number;
  coverage: unknown;
  pairSets?: { secondGlyph: number; value1?: { xAdvance?: number } }[][];
  classDef1?: unknown;
  classDef2?: unknown;
  classRecords?: { value1?: { xAdvance?: number } }[][];
}

interface Position {
  getCoverageIndex(coverage: unknown, glyph: number): number;
  getGlyphClass(classDef: unknown, glyph: number): number;
}

/**
 * The advance change of a pair of glyphs, in font units: the pair adjustment lookups (GPOS type 2)
 * the kern feature names, added up as a shaper applies them; without GPOS, the kern table.
 */
function pairKerning(font: OpenTypeFont): (left: number, right: number) => number {
  const gpos = font.tables.gpos as
    | {
        features?: { tag: string; feature: { lookupListIndexes: number[] } }[];
        lookups?: { lookupType: number; subtables: PairSubtable[] }[];
      }
    | undefined;
  const position = (font as unknown as { position: Position }).position;
  const named = new Set(
    (gpos?.features ?? [])
      .filter((item) => item.tag === 'kern')
      .flatMap((item) => item.feature.lookupListIndexes),
  );
  const lookups = (gpos?.lookups ?? []).filter(
    (lookup, index) => lookup.lookupType === 2 && named.has(index),
  );
  if (!lookups.length) {
    return (left, right) =>
      font.getKerningValue(font.glyphs.get(left), font.glyphs.get(right)) as number;
  }
  return (left, right) => {
    let total = 0;
    for (const lookup of lookups) {
      for (const table of lookup.subtables) {
        const covered = position.getCoverageIndex(table.coverage, left);
        if (covered < 0) continue;
        if (table.posFormat === 1) {
          const pair = table.pairSets?.[covered]?.find((item) => item.secondGlyph === right);
          if (pair) {
            total += pair.value1?.xAdvance ?? 0;
            break; // a lookup applies its first subtable that has the pair
          }
        } else {
          const first = position.getGlyphClass(table.classDef1, left);
          const second = position.getGlyphClass(table.classDef2, right);
          total += table.classRecords?.[first]?.[second]?.value1?.xAdvance ?? 0;
          break; // a class subtable that covers the first glyph is the one that applies
        }
      }
    }
    return total;
  };
}
