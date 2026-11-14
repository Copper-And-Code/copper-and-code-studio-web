"""First-frame references: upstream's desktop runtime draws the first frame of each example game.

For each example project, build/preview.py's render_with_log runs the generated project in the
native runtime with LVSIM_HEADLESS, LVSIM_FRAMES=1 and LVSIM_TICK_MS=0, the project's code
included (design_only=False), from the page the project starts on. The frame is written as a PNG
with build/visual.py's write_png, as upstream's visual tests write their references.

The web simulator must draw the same first frame (tests/e2e/simulator.spec.ts), within the
threshold of upstream's visual tests, which is 0 different pixels by default.

The native runtime is not built in the submodule: pass the one of a desktop checkout, built with
upstream's runtime/build.sh at the same tag.

Usage: python3 -I scripts/frames.py <runtime executable> [out]   (default: tests/fixtures/frames)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from lvgl_mpy_studio import __version__  # noqa: E402
from lvgl_mpy_studio.build import preview  # noqa: E402
from lvgl_mpy_studio.build.visual import rgb565_to_rgb, write_png  # noqa: E402
from lvgl_mpy_studio.core.model import Project  # noqa: E402

GAMES = ("breakout", "fifteen", "simon", "snake", "tictactoe")


def initial_page(project):
    """The page generate_project starts from when it is not told: gen/project_gen.py."""
    full = project.to_dict()
    current = full.get("currentPageId")
    return next((index for index, page in enumerate(full["pages"]) if page.get("id") == current), 0)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    runtime = Path(argv[1]).resolve()
    out = Path(argv[2]) if len(argv) > 2 else ROOT / "tests" / "fixtures" / "frames"
    preview.runtime_path = lambda: runtime  # the submodule has no native runtime of its own
    out.mkdir(parents=True, exist_ok=True)
    index = {"upstreamVersion": __version__, "frames": {}}
    for name in GAMES:
        project = Project.load(UPSTREAM / "examples" / name / "project.json")
        page = initial_page(project)
        frames = []
        for _attempt in range(2):  # an unstable first frame is no reference
            pixels, log = preview.render_with_log(project, page, design_only=False)
            if pixels is None:
                raise SystemExit(f"{name}: no frame: {log}")
            frames.append(pixels)
        if frames[0] != frames[1]:
            raise SystemExit(f"{name}: the first frame changes between two runs")
        width, height = project.display.width, project.display.height
        write_png(out / f"{name}.png", rgb565_to_rgb(frames[0]), width, height)
        index["frames"][name] = {"page": project.pages[page].name, "width": width, "height": height}
        print(f"{name}: page {project.pages[page].name}, {width}x{height}")
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
