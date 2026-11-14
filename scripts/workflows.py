"""Designer workflow references: each workflow of tests/fixtures/workflows/workflows.json, done
with upstream's core on the host, as the desktop's ui/ code does it after its dialogs.

A step is what the desktop's ui/ code does after its dialogs:
- "resolution": ui/main_resolution.py change_resolution, project.resize with the mode chosen,
  the board unlinked when its size is another one;
- "addPage", "initialPage", "deletePage": ui/main_tree.py add_page, set_initial_page,
  delete_page;
- "select", then "set" [property, text] and "event": ui/properties/panel.py _item_changed (the
  value read by the type of the property, a new name through rename_widget) and
  _event_activated (ensure_handler).

- "page", then the canvas's steps ("add", "drop", "move", "resize", "copy", "cut",
  "paste", "duplicate", "delete", "align", "distribute", "front", "back"): upstream's own
  ui/designer/scene.py DesignerScene, run offscreen with PySide6, on upstream's own
  ui/document.py ProjectDocument; "adaptPage": ui/main_resolution.py adapt_current_page;
- "projectSettings" [profile id, mode]: ui/main_resolution.py open_project_settings with the
  profile chosen in ProjectSettingsDialog, which fixes the resolution;
- "file" [property, file under tests/fixtures]: upstream's own ui/properties/panel.py
  PropertiesPanel, the file's path typed into the property, as its … button does: Qt reads the
  picture, fontconv.py converts the font;
- "code" [object, event, text]: upstream's own ui/code/editor.py CodePanel: the object and the
  procedure chosen, the text typed into its editor (a handler not made yet is made by it).
  These need PySide6: run the script with the Python of a desktop checkout's environment.

The project is written as core/model.py Project.save writes it, with projectId normalised (Save
As gives the copy a new one), and every id a step created, a uuid, by its order in the file.

The web IDE must save the same file (tests/e2e/designer.spec.ts). A picture is stored as PNG,
which Qt and the browser encode differently: its data is replaced by the size of the picture, its
pixels are compared by the e2e test. With "frame", the page is also drawn by the native runtime,
as the designer's preview draws it (build/preview.py render_page): pass the runtime executable
of a desktop checkout in LMS_RUNTIME.

Usage: <python with PySide6> -I scripts/workflows.py [out]   (default: tests/fixtures/workflows)
"""

import json
import re
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


def property_type(project, names, name):
    from lvgl_mpy_studio.core.components import COMPONENTS
    from lvgl_mpy_studio.core.model import widget_definitions

    definitions = {**widget_definitions(), **COMPONENTS}
    for widget_name in names:
        widget = project.find_widget(widget_name)
        for item in definitions.get(widget.type, {}).get("properties") or []:
            if item["name"] == name:
                return item.get("type", "string")
    return "string"


def set_property(project, names, name, text):
    """_item_changed's mutate, after its checks."""
    from lvgl_mpy_studio.core.blocks import parse_pin

    if name == "Name":
        project.rename_widget(names[0], text)
        return [text]
    kind = property_type(project, names, name)
    value = int(text) if kind == "number" else parse_pin(text) if kind == "pin" else text.lower() == "true" if kind == "boolean" else text
    for widget_name in names:
        project.find_widget(widget_name).props[name] = value
    return names


ID = re.compile(r'"id": "([0-9a-f]{32})"')
PICTURE = re.compile(r'"data": "data:image/png;base64,([A-Za-z0-9+/=]+)"')


def picture_size(match):
    """A picture's PNG data, as its size: Qt and the browser encode the same pixels differently."""
    import base64

    data = base64.b64decode(match.group(1))
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    return f'"data": "<png {width}x{height}>"'


def normalised(project, original_ids):
    """Project.save's text; projectId and each new id replaced, as tests/e2e/designer.spec.ts does."""
    data = project.to_dict()
    data["projectId"] = NORMALISED
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    text = PICTURE.sub(picture_size, text)
    created = []
    for found in ID.findall(text):
        if found not in original_ids and found not in created:
            created.append(found)
    for number, new_id in enumerate(created, 1):
        text = text.replace(new_id, f"<new {number}>")
    return text


def write_frame(project, page_name, target):
    """build/preview.py render_page with the native runtime, as the designer's preview draws it."""
    import os

    from lvgl_mpy_studio.build import preview
    from lvgl_mpy_studio.build.visual import rgb565_to_rgb, write_png

    runtime = os.environ.get("LMS_RUNTIME")
    if not runtime:
        raise SystemExit("LMS_RUNTIME: the native runtime, for the frame of a workflow")
    preview.runtime_path = lambda: Path(runtime)
    index = next(number for number, page in enumerate(project.pages) if page.name == page_name)
    pixels, log = preview.render_with_log(project, index)
    if pixels is None:
        raise SystemExit(f"no frame: {log}")
    write_png(target, rgb565_to_rgb(pixels), project.display.width, project.display.height)


def all_ids(project):
    return set(ID.findall(json.dumps(project.to_dict(), indent=2)))


class Canvas:
    """The desktop's canvases of one document: a DesignerScene per page, as MainWindow keeps them."""

    def __init__(self, project):
        from PySide6.QtWidgets import QApplication

        from lvgl_mpy_studio.ui.document import ProjectDocument

        self.app = QApplication.instance() or QApplication(["workflows", "-platform", "offscreen"])
        self.document = ProjectDocument(project)
        self.scenes = {}
        self.page = None

    def scene(self):
        from lvgl_mpy_studio.ui.designer.scene import DesignerScene

        page = next(item for item in self.document.project.pages if item.name == self.page)
        if page.id not in self.scenes:
            self.scenes[page.id] = DesignerScene(self.document, page.id)
        return self.scenes[page.id]

    def select(self, names):
        self.selected = list(names)
        scene = self.scene() if self.page else None
        if scene is None:
            return
        scene.clearSelection()
        for item in scene.widget_items.values():
            if item.name in names:
                item.setSelected(True)

    def step(self, step):
        from PySide6.QtCore import QPointF, Qt  # noqa: F401

        from lvgl_mpy_studio.core.i18n import tr

        if "page" in step:
            self.page = step["page"]
            return True
        if "file" in step:
            from lvgl_mpy_studio.ui.properties.panel import DESCRIPTOR_ROLE, PropertiesPanel

            if not hasattr(self, "properties"):
                self.properties = PropertiesPanel(self.document)
            name, path = step["file"]
            self.properties.set_selection(self.selected)
            for row in self.properties.model.findItems("", Qt.MatchContains | Qt.MatchRecursive, 0):
                value = row.parent().child(row.row(), 1) if row.parent() else self.properties.model.item(row.row(), 1)
                descriptor = value.data(DESCRIPTOR_ROLE) if value else None
                if descriptor and descriptor.get("name") == name:
                    value.setText(str(ROOT / "tests" / "fixtures" / path))
                    break
            else:
                raise SystemExit(f"no property {name}")
            self.properties.rebuild()
            return True
        if "code" in step:
            from lvgl_mpy_studio.ui.code.editor import CodePanel

            if not hasattr(self, "code"):
                self.code = CodePanel(self.document)
            key, event, text = step["code"]
            kind, _, name = key.partition(":")
            if kind == "module":
                self.code.object_combo.setCurrentIndex(0)
            else:
                self.code.object_combo.setCurrentIndex(self.code._find_object((kind, name)))
                self.code.procedure_combo.setCurrentIndex(self.code.procedure_combo.findText(event))
            self.code.editor.setPlainText(text)
            return True
        scene = self.scene() if self.page else None
        if "add" in step or "drop" in step:
            widget_type, x, y = step.get("add") or step["drop"]
            scene.add_widget(widget_type, QPointF(x, y), centered="drop" in step)
        elif "move" in step:
            scene.move_selected(*step["move"])
        elif "resize" in step:  # the bottom right ResizeHandle, dragged to the new size
            items = []
            for name, (width, height) in step["resize"].items():
                item = next(item for item in scene.widget_items.values() if item.name == name)
                x, y, _width, _height = item.geometry()
                item.set_geometry(x, y, width, height)
                items.append(item)
            scene.commit_items(items)
        elif "copy" in step or "cut" in step:
            scene.copy_selected(cut="cut" in step)
        elif "paste" in step:
            scene.paste()
        elif "duplicate" in step:
            scene.duplicate_selected()
        elif "delete" in step:
            scene.delete_selected()
        elif "align" in step:
            scene.align_selected(step["align"])
        elif "distribute" in step:
            scene.distribute_selected(step["distribute"])
        elif "front" in step or "back" in step:
            scene.change_z("front" in step)
        elif "adaptPage" in step:
            page = next(item for item in self.document.project.pages if item.name == step["adaptPage"])
            self.document.execute(tr("Adapt Page to Resolution"), lambda project: project.adapt_page(next(item for item in project.pages if item.id == page.id), step["mode"]))
        else:
            return False
        return True


def main(argv):
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "tests" / "fixtures" / "workflows"
    spec = json.loads((ROOT / "tests" / "fixtures" / "workflows" / "workflows.json").read_text(encoding="utf-8"))
    for workflow in spec["workflows"]:
        project = Project.load(UPSTREAM / "examples" / workflow["example"] / "project.json")
        original_ids = all_ids(project)
        selected = []
        canvas = None
        for step in workflow["steps"]:
            if canvas is not None or any(key in step for key in ("page", "adaptPage", "code", "file")):
                if canvas is None:
                    canvas = Canvas(project)
                    canvas.selected = list(selected)
                project = canvas.document.project  # undo and redo replace it
                if "select" in step:
                    canvas.select(step["select"])
                    continue
                if "set" in step:
                    canvas.selected = set_property(project, canvas.selected, *step["set"])
                    continue
                if "resolution" in step:
                    width, height = step["resolution"]
                    canvas.document.execute("Change Resolution", lambda p, w=width, h=height, m=step["mode"]: change_resolution(p, w, h, m))
                    continue
                if canvas.step(step):
                    project = canvas.document.project
                    continue
                raise SystemExit(f"{workflow['name']}: unknown step {step}")
            if "resolution" in step:
                width, height = step["resolution"]
                change_resolution(project, width, height, step["mode"])
            elif "addPage" in step:
                add_page(project)
            elif "initialPage" in step:
                initial_page(project, step["initialPage"])
            elif "projectSettings" in step:
                from lvgl_mpy_studio.core.boards import ProfileStore, portable_profile

                profile_id, mode = step["projectSettings"]
                profile = portable_profile(next(item for item in ProfileStore(Path("/nonexistent/profiles.json")).profiles() if item["id"] == profile_id))
                project.resize(profile["logicalWidth"], profile["logicalHeight"], mode)
                project.board = profile
            elif "select" in step:
                selected = step["select"]
            elif "set" in step:
                selected = set_property(project, selected, *step["set"])
            elif "event" in step:
                project.ensure_handler(selected[0], step["event"])
            elif "deletePage" in step:
                project.remove_page(next(page for page in project.pages if page.name == step["deletePage"]))
            else:
                raise SystemExit(f"{workflow['name']}: unknown step {step}")
        (out / f"{workflow['name']}.json").write_text(normalised(project, original_ids), encoding="utf-8", newline="\n")
        if workflow.get("frame"):
            write_frame(project, workflow["frame"], out / f"{workflow['name']}.png")
        print(workflow["name"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
