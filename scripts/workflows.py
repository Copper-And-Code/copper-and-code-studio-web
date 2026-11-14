"""Designer workflow references: each workflow of tests/fixtures/workflows/workflows.json, done
with upstream's core on the host, as the desktop's ui/ code does it after its dialogs.

A step "resolution" is ui/main_resolution.py change_resolution: project.resize with the mode
chosen in the dialog, and the board unlinked when its size is another one. The project is
written as core/model.py Project.save writes it, with projectId normalised: Save As gives the
copy a new one.

The web IDE must save the same file (tests/e2e/designer.spec.ts).

Usage: python3 -I scripts/workflows.py [out]   (default: tests/fixtures/workflows)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from lvgl_mpy_studio.core.model import Project  # noqa: E402

NORMALISED = "<normalised>"


def change_resolution(project, width, height, mode):
    """ui/main_resolution.py change_resolution's mutate."""
    board = project.board
    unlink = bool(board) and (board["logicalWidth"], board["logicalHeight"]) != (width, height)
    project.resize(width, height, mode)
    if unlink:
        project.board = None
        project.runTarget = None


def normalised(project):
    data = project.to_dict()
    data["projectId"] = NORMALISED
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def main(argv):
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "tests" / "fixtures" / "workflows"
    spec = json.loads((ROOT / "tests" / "fixtures" / "workflows" / "workflows.json").read_text(encoding="utf-8"))
    for workflow in spec["workflows"]:
        project = Project.load(UPSTREAM / "examples" / workflow["example"] / "project.json")
        for step in workflow["steps"]:
            if "resolution" in step:
                width, height = step["resolution"]
                change_resolution(project, width, height, step["mode"])
            else:
                raise SystemExit(f"{workflow['name']}: unknown step {step}")
        (out / f"{workflow['name']}.json").write_text(normalised(project), encoding="utf-8", newline="\n")
        print(workflow["name"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
