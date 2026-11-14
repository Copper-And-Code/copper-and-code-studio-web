// What src/fonts/rasterise.ts uses of opentype.js 1.3.4, which ships no types.
declare module 'opentype.js' {
  interface Glyph {
    index: number;
  }
  interface Font {
    unitsPerEm: number;
    tables: Record<string, unknown>;
    glyphs: { get(index: number): Glyph };
    charToGlyphIndex(char: string): number;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
