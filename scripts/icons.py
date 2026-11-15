"""The icons of the installed app (public/manifest.webmanifest), drawn from upstream's own icon
(upstream/packaging/lvgl-mpy-studio.svg) with Qt, as upstream's packaging/make_icon.sh draws its
icon.ico. The PNGs are committed; run this again only when upstream's drawing changes.

The maskable icon fills its square with the icon's background colour and draws the icon in the
middle 80 %, the safe zone that Android keeps when it cuts the icon into a circle or a squircle.

Usage: <python with PySide6> -I scripts/icons.py
"""

import sys
from pathlib import Path

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "upstream" / "packaging" / "lvgl-mpy-studio.svg"
OUT = ROOT / "public" / "icons"
BACKGROUND = "#17324d"  # the SVG's own background


def draw(renderer, size, maskable=False):
    image = QImage(size, size, QImage.Format_ARGB32)
    image.fill(QColor(BACKGROUND) if maskable else Qt.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.Antialiasing)
    margin = size * 0.1 if maskable else 0
    renderer.render(painter, QRectF(margin, margin, size - 2 * margin, size - 2 * margin))
    painter.end()
    return image


def main():
    QGuiApplication(sys.argv[:1])
    renderer = QSvgRenderer(str(SVG))
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
    ):
        draw(renderer, size, maskable).save(str(OUT / name))
        print(OUT / name)


if __name__ == "__main__":
    main()
