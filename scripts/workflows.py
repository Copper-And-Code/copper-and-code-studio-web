"""Designer workflow references: each workflow of tests/fixtures/workflows/workflows.json, done
with upstream's core on the host, as the desktop's ui/ code does it after its dialogs.

A step is what the desktop's ui/ code does after its dialogs:
- "resolution": ui/main_resolution.py change_resolution, project.resize with the mode chosen,
  the board unlinked when its size is another one;
- "addPage", "initialPage", "deletePage": ui/main_tree.py add_page, set_initial_page,
  delete_page.

The project is written as core/model.py Project.save writes it, with projectId normalised (Save
As gives the copy a new one), and the id of each page a step created: a uuid.

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


def add_page(project):
    project.pages.append(project.new_page(f"page{len(project.pages) + 1}"))


def initial_page(project, name):
    selected = next(page for page in project.pages if page.name == name)
    project.pages.remove(selected)
    project.pages.insert(0, selected)
    project.currentPageId = selected.id


def normalised(project, original_ids):
    data = project.to_dict()
    data["projectId"] = NORMALISED
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    created = [page["id"] for page in data["pages"] if page["id"] not in original_ids]
    for number, page_id in enumerate(created, 1):
        text = text.replace(page_id, f"<new page {number}>")
    return text


def main(argv):
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "tests" / "fixtures" / "workflows"
    spec = json.loads((ROOT / "tests" / "fixtures" / "workflows" / "workflows.json").read_text(encoding="utf-8"))
    for workflow in spec["workflows"]:
        project = Project.load(UPSTREAM / "examples" / workflow["example"] / "project.json")
        original_ids = {page.id for page in project.pages}
        for step in workflow["steps"]:
            if "resolution" in step:
                width, height = step["resolution"]
                change_resolution(project, width, height, step["mode"])
            elif "addPage" in step:
                add_page(project)
            elif "initialPage" in step:
                initial_page(project, step["initialPage"])
            elif "deletePage" in step:
                project.remove_page(next(page for page in project.pages if page.name == step["deletePage"]))
            else:
                raise SystemExit(f"{workflow['name']}: unknown step {step}")
        (out / f"{workflow['name']}.json").write_text(normalised(project, original_ids), encoding="utf-8", newline="\n")
        print(workflow["name"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
