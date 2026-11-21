"""Designer references: upstream's desktop runtime draws every page of each example, as the
designer's Real LVGL Preview shows it.

For each page of each example project, build/preview.py's render_page runs the page generated
design-only (the project's code left out) in the native runtime, with LVSIM_HEADLESS,
LVSIM_FRAMES=1 and LVSIM_TICK_MS=0. The frame is written as a PNG with build/visual.py's
write_png, as upstream's visual tests write their references.

The web designer must draw the same pages (tests/e2e/designer.spec.ts), within the threshold of
upstream's visual tests, which is 0 different pixels by default.

The native runtime is not built in the submodule: pass the one of a desktop checkout, built with
upstream's runtime/build.sh at the same tag.

Usage: python3 -I scripts/previews.py <runtime executable> [out]   (default: tests/fixtures/previews)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from copper_and_code_studio import __version__  # noqa: E402
from copper_and_code_studio.build import preview  # noqa: E402
from copper_and_code_studio.build.visual import rgb565_to_rgb, write_png  # noqa: E402
from copper_and_code_studio.core.model import Project  # noqa: E402


def file_name(page):
    """build/visual.py _file_name."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", page.name)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    runtime = Path(argv[1]).resolve()
    out = Path(argv[2]) if len(argv) > 2 else ROOT / "tests" / "fixtures" / "previews"
    preview.runtime_path = lambda: runtime  # the submodule has no native runtime of its own
    index = {"upstreamVersion": __version__, "projects": {}}
    for path in sorted((UPSTREAM / "examples").glob("*/project.json")):
        name = path.parent.name
        project = Project.load(path)
        width, height = project.display.width, project.display.height
        pages = []
        for number, page in enumerate(project.pages):
            frames = []
            for _attempt in range(2):  # an unstable frame is no reference
                pixels, log = preview.render_with_log(project, number)
                if pixels is None:
                    raise SystemExit(f"{name}/{page.name}: no frame: {log}")
                frames.append(pixels)
            if frames[0] != frames[1]:
                raise SystemExit(f"{name}/{page.name}: the frame changes between two runs")
            target = out / name / f"{file_name(page)}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            write_png(target, rgb565_to_rgb(frames[0]), width, height)
            pages.append({"page": page.name, "file": f"{name}/{target.name}"})
            print(f"{name}: page {page.name}, {width}x{height}")
        index["projects"][name] = {"width": width, "height": height, "pages": pages}
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
