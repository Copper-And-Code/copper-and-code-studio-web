"""Generation goldens: upstream run on the host, with CPython, for every example project.

For each project the output is what upstream's CLI writes:
  <out>/<name>/py/     `lvgl-mpy-studio generate <project>`             (generate_project)
  <out>/<name>/board/  `lvgl-mpy-studio generate <project> --target board`, for projects with a board

The CLI's own `generate` also compiles the files with mpy-cross, which is not part of the
generated code and is not built in the submodule; so this script calls the same functions the CLI
calls, `generate_project`, and `portable_profile` + `export_board` as `cli._board_export` does,
and stops before compiling. The warnings go into index.json instead of stderr.

The web IDE must give byte-identical files (tests/py/goldens.test.ts).

Usage: python3 -I scripts/goldens.py [out]     (default: tests/fixtures/goldens)
"""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from lvgl_mpy_studio import __version__  # noqa: E402
from lvgl_mpy_studio.core.boards import portable_profile  # noqa: E402
from lvgl_mpy_studio.gen.board_gen import export_board  # noqa: E402
from lvgl_mpy_studio.core.model import Project  # noqa: E402
from lvgl_mpy_studio.gen.project_gen import generate_project  # noqa: E402


def example_projects():
    """{name: path} of every example project: examples/<name>/project.json, and examples/demo.json."""
    projects = {path.parent.name: path for path in sorted((UPSTREAM / "examples").glob("*/project.json"))}
    projects["demo"] = UPSTREAM / "examples" / "demo.json"
    return projects


def main(argv):
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "tests" / "fixtures" / "goldens"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    index = {"upstreamVersion": __version__, "python": sys.version.split()[0], "projects": {}}
    for name, path in example_projects().items():
        project = Project.load(path)
        generated = generate_project(project, out / name / "py")
        entry = {"project": path.relative_to(UPSTREAM).as_posix(), "warnings": generated["warnings"], "board": None}
        if project.board is not None:
            exported = export_board(project, portable_profile(project.board), out / name / "board")
            entry["board"] = {"profile": exported["profile"]["id"], "warnings": exported["warnings"]}
        index["projects"][name] = entry
        print(f"{name}: py{' + board' if entry['board'] else ''}")
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
