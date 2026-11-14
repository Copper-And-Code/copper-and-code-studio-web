"""Font references: LVGL's own Montserrat, and upstream's fontconv.py on the same TrueType file.

LVGL's built-in Montserrat was made by lv_font_conv from Montserrat-Medium.ttf; upstream's
tests/test_fonts.py compares fontconv.py with it, and states the parity: the same metrics, pixels
within one level of sixteen on under 0.1 %, the same kerning wherever LVGL's font has it. The web
IDE's converter (src/fonts/rasterise.ts) is held to the same, and compared with fontconv.py too
(tests/unit/fonts.test.ts).

For each size: the built-in glyphs and kerning, read from LVGL's C source as upstream's test reads
them, and fontconv.rasterise's glyphs and kerning. fontconv needs Qt: run with the Python of a
desktop checkout's environment, and pass the LVGL source folder of that checkout.

Usage: <python with PySide6> -I scripts/fonts.py <lvgl source folder> [out]   (default: tests/fixtures/fonts)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from lvgl_mpy_studio import __version__  # noqa: E402
from lvgl_mpy_studio.fontconv import rasterise  # noqa: E402

SIZES = (14, 24, 40)
ASCII = "".join(chr(code) for code in range(32, 127))


def builtin(lvgl, size):
    """upstream tests/test_fonts.py builtin and builtin_kerning."""
    source = (lvgl / "src" / "font" / f"lv_font_montserrat_{size}.c").read_text()
    records = [tuple(int(value) for value in match) for match in re.findall(r"\{\.bitmap_index = (\d+), \.adv_w = (\d+), \.box_w = (\d+), \.box_h = (\d+), \.ofs_x = (-?\d+), \.ofs_y = (-?\d+)\}", source)]
    start = source.index("glyph_bitmap[] = {")
    data = bytes(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{1,2})", re.sub(r"/\*.*?\*/", "", source[start:source.index("};", start)])))
    glyphs = []
    for code in range(32, 127):
        index, advance, width, height, ofs_x, ofs_y = records[code - 31]
        nibbles = [value for byte in data[index:index + (width * height + 1) // 2] for value in (byte >> 4, byte & 15)]
        glyphs.append({"code": code, "advance": advance, "width": width, "height": height, "ofs_x": ofs_x, "ofs_y": ofs_y, "pixels": nibbles[:width * height]})

    def array(name):
        return [int(value) for value in re.findall(r"-?\d+", re.sub(r"/\*.*?\*/", "", re.search(name + r"\[\] =\s*\{(.*?)\};", source, re.S).group(1), flags=re.S))]

    left, right, values = array("kern_left_class_mapping"), array("kern_right_class_mapping"), array("kern_class_values")
    columns = max(right)
    kerning = {f"{a},{b}": values[(left[a - 31] - 1) * columns + right[b - 31] - 1] for a in range(32, 127) for b in range(32, 127) if left[a - 31] and right[b - 31]}
    return {"glyphs": glyphs, "kerning": {pair: value for pair, value in kerning.items() if value}}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    lvgl = Path(argv[1])
    out = Path(argv[2]) if len(argv) > 2 else ROOT / "tests" / "fixtures" / "fonts"
    data = (out / "Montserrat-Medium.ttf").read_bytes()
    for size in SIZES:
        font, missing = rasterise(data, size, ASCII)
        qt = {
            "glyphs": [{**glyph, "pixels": list(glyph["pixels"])} for glyph in font["glyphs"]],
            "kerning": {f"{a},{b}": value for (a, b), value in font["kerning"].items()},
            "underline_position": font["underline_position"],
            "underline_thickness": font["underline_thickness"],
            "missing": missing,
        }
        reference = {"upstreamVersion": __version__, "size": size, "lvgl": builtin(lvgl, size), "fontconv": qt}
        (out / f"montserrat-{size}.json").write_text(json.dumps(reference, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
        print(size, len(font["glyphs"]), "glyphs,", len(font["kerning"]), "kerned pairs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
