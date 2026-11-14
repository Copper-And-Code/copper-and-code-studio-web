// The PNGs that upstream's build/visual.py writes (8-bit RGB, no filter), and its compare(): how
// many pixels differ. The frame from the simulator is RGB565, turned into RGB as rgb565_to_rgb.
import { readFileSync } from 'node:fs';
import { unzlibSync } from 'fflate';

export interface Rgb {
  rgb: Uint8Array;
  width: number;
  height: number;
}

export function readPng(path: string): Rgb {
  const data = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  const chunks: Buffer[] = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const kind = data.toString('latin1', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 2) throw new Error(`${path}: not 8-bit RGB`);
    } else if (kind === 'IDAT') chunks.push(body);
    offset += 12 + length;
  }
  const rows = unzlibSync(Buffer.concat(chunks));
  const stride = width * 3 + 1;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    if (rows[row * stride] !== 0) throw new Error(`${path}: filtered rows are not upstream's`);
    rgb.set(rows.subarray(row * stride + 1, (row + 1) * stride), row * width * 3);
  }
  return { rgb, width, height };
}

export function rgb565ToRgb(pixels: Uint8Array): Uint8Array {
  const result = new Uint8Array((pixels.length / 2) * 3);
  for (let index = 0; index < pixels.length / 2; index++) {
    const value = ((pixels[index * 2 + 1] ?? 0) << 8) | (pixels[index * 2] ?? 0);
    const red = value >> 11;
    const green = (value >> 5) & 0x3f;
    const blue = value & 0x1f;
    result[index * 3] = (red << 3) | (red >> 2);
    result[index * 3 + 1] = (green << 2) | (green >> 4);
    result[index * 3 + 2] = (blue << 3) | (blue >> 2);
  }
  return result;
}

export function differentPixels(expected: Uint8Array, actual: Uint8Array): number {
  let different = 0;
  for (let index = 0; index < expected.length; index += 3) {
    if (
      expected[index] !== actual[index] ||
      expected[index + 1] !== actual[index + 1] ||
      expected[index + 2] !== actual[index + 2]
    ) {
      different++;
    }
  }
  return different + Math.abs(expected.length - actual.length) / 3;
}
