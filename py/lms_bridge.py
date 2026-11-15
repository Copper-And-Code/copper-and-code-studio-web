"""The calls the web IDE makes into upstream, running in Pyodide.

Thin glue only: every function hands its work to upstream's own code, unchanged, and turns the
result into JSON for the TypeScript side. No upstream logic is reimplemented here.

call(method, arguments_json) -> reply_json is the single entry point. A reply is
{"ok": true, "result": ...} or {"ok": false, "error": {"type": ..., "message": ...}}.
"""

import copy
import json
import re
import shutil
import sys
import tempfile
import traceback
from pathlib import Path


def _read_tree(directory):
    """Every file under directory, as {relative posix path: text}. The bytes are decoded as they
    are, without newline translation, so the text is the file byte for byte."""
    root = Path(directory)
    return {path.relative_to(root).as_posix(): path.read_bytes().decode("utf-8") for path in sorted(root.rglob("*")) if path.is_file()}


def _load_project(folder, project_text):
    """Write the project file and load it as the desktop IDE does, validation included."""
    from lvgl_mpy_studio.core.model import Project

    path = Path(folder) / "project.json"
    path.write_text(project_text, encoding="utf-8", newline="")
    return Project.load(path)


def info():
    from lvgl_mpy_studio import __version__

    return {"upstreamVersion": __version__, "python": sys.version.split()[0]}


def set_language(code):
    """core/i18n.py set_language: upstream's own messages in the IDE's language."""
    from lvgl_mpy_studio.core.i18n import set_language as choose

    return choose(code)


def generate(project_text):
    """The project's MicroPython code, as upstream's generate_project writes it (CLI: generate)."""
    from lvgl_mpy_studio.gen.project_gen import generate_project

    folder = tempfile.mkdtemp(prefix="lms-generate-")
    try:
        project = _load_project(folder, project_text)
        generated = generate_project(project, Path(folder) / "py")
        return {"files": _read_tree(Path(folder) / "py"), "warnings": generated["warnings"], "modules": generated["modules"]}
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def export_board(project_text, profile_id=None):
    """The sources for a board, as upstream's export_board writes them (CLI: generate --target board)."""
    from lvgl_mpy_studio.core.boards import ProfileStore, portable_profile
    from lvgl_mpy_studio.core.i18n import device_error_text
    from lvgl_mpy_studio.gen.board_gen import export_board as upstream_export

    folder = tempfile.mkdtemp(prefix="lms-board-")
    try:
        project = _load_project(folder, project_text)
        if profile_id:
            profile = ProfileStore().get(profile_id)
            if profile is None:
                raise ValueError(f"profile.not-found:{profile_id}")
        elif project.board is not None:
            profile = project.board
        else:
            raise ValueError(device_error_text("device.profile.required"))
        generated = upstream_export(project, portable_profile(profile), Path(folder) / "board")
        return {"files": _read_tree(Path(folder) / "board"), "warnings": generated["warnings"], "profile": generated["profile"]["id"]}
    finally:
        shutil.rmtree(folder, ignore_errors=True)


# The open project, one per IDE window as on the desktop. Paths are in Pyodide's file system:
# the page copies the file there from the workspace before each operation that reads it, and
# back after a save (src/project/session.ts).
_document = None


def _doc():
    global _document
    if _document is None:
        from lms_document import ProjectDocument

        _document = ProjectDocument()
    return _document


def doc_state():
    document = _doc()
    project = document.project
    stack = document.undo_stack
    return {
        "path": str(document.path) if document.path else None,
        "modified": document.modified,
        "projectName": project.projectName,
        "board": project.board.get("id") if isinstance(project.board, dict) else None,
        "display": {"width": project.display.width, "height": project.display.height},
        "pages": [{"id": page.id, "name": page.name} for page in project.pages],
        "modules": [{"id": module.id, "name": module.name} for module in project.modules],
        "runTarget": _run_target(project),
        "canUndo": stack.can_undo(),
        "canRedo": stack.can_redo(),
        "undoText": stack.undo_text(),
        "redoText": stack.redo_text(),
    }


def _run_target(project):
    """MainWindow.run_target: a board only with a board profile, otherwise the simulator."""
    saved = project.runTarget or {}
    return "board" if saved.get("kind") == "board" and project.board else "simulator"


def run_target_plan(kind, profile_id=None):
    """select_run_target before the question: the same target changes nothing; a board of
    another profile brings its resolution, after validate_profile."""
    from lvgl_mpy_studio.core.boards import ProfileStore, validate_profile

    project = _doc().project
    current = project.board.get("id") if project.board else None
    if kind == _run_target(project) and (kind == "simulator" or profile_id == current):
        return {"same": True}
    if kind == "board" and profile_id != current:
        profile = ProfileStore.tolerant().get(profile_id)
        try:
            validate_profile(profile)
        except (TypeError, ValueError) as exc:
            return {"same": False, "error": str(exc)}
        return {"same": False, "size": {"width": profile["logicalWidth"], "height": profile["logicalHeight"]}}
    return {"same": False}


def doc_set_run_target(kind, profile_id=None, mode="keep"):
    """select_run_target's mutate: one undo step, then _report_outside."""
    from lvgl_mpy_studio.core.boards import ProfileStore, portable_profile
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    current = document.project.board.get("id") if document.project.board else None
    profile = ProfileStore.tolerant().get(profile_id) if kind == "board" and profile_id != current else None

    def mutate(project):
        project.runTarget = None if kind == "simulator" else {"kind": kind, "language": "micropython"}
        if profile:
            project.board = portable_profile(profile)
            project.resize(profile["logicalWidth"], profile["logicalHeight"], mode)

    document.execute(tr("Change run target"), mutate)
    outside = document.project.widgets_outside(profile["logicalWidth"], profile["logicalHeight"]) if profile else []
    return {"outside": outside, "state": doc_state()}


def new_project_defaults():
    """save_new_project_defaults: what the desktop keeps in defaults/newProject."""
    project = _doc().project
    return {"board": project.board["id"] if project.board else None, "runTarget": project.runTarget, "width": project.display.width, "height": project.display.height}


def profiles():
    """The board profiles, as the desktop's profile store lists them."""
    from lvgl_mpy_studio.core.boards import ProfileStore

    return [{"id": profile["id"], "name": profile.get("name", profile["id"]), "width": profile["logicalWidth"], "height": profile["logicalHeight"], "origin": profile["origin"]} for profile in ProfileStore.tolerant().profiles()]


def doc_new(defaults=None, board=None):
    """File > New Project: the user's defaults for new projects, or a board chosen by the user."""
    from lvgl_mpy_studio.core.boards import ProfileStore
    from lms_document import default_project

    if board is not None:
        defaults = {**(defaults or {}), "board": board}
    _doc().new(default_project(defaults, ProfileStore.tolerant()))
    return doc_state()


def doc_open(path):
    _doc().open(path)
    return doc_state()


def doc_reload():
    _doc().reload()
    return doc_state()


def doc_external_change():
    return _doc().external_change()


_before_save = None


def doc_save(path=None, overwrite_external=False):
    global _before_save
    document = _doc()
    _before_save = (document.path, document.disk_revision, document.project.projectId)
    document.save(path, overwrite_external)
    return doc_state()


def doc_mark_unsaved():
    """The page could not write the saved file into its store: back to the state before the save."""
    document = _doc()
    if _before_save is not None:
        document.path, document.disk_revision, document.project.projectId = _before_save
    document.undo_stack.clean_index = -1
    return doc_state()


def doc_undo():
    _doc().undo_stack.undo()
    return doc_state()


def doc_redo():
    _doc().undo_stack.redo()
    return doc_state()


def doc_rename_page(page_id, name):
    """ui/main_tree.py rename_page, after the dialog: the same checks and the same undo step."""
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.model import page_constant

    document = _doc()
    page = next(item for item in document.project.pages if item.id == page_id)
    if not name or name == page.name:
        return {"error": None, "warnings": [], "state": doc_state()}
    if any(page_constant(item.name) == page_constant(name) for item in document.project.pages if item.id != page.id):
        return {"error": tr("A page named {name} already exists", name=name), "warnings": [], "state": doc_state()}
    warnings = []
    document.execute(tr("Rename Page"), lambda project: warnings.extend(project.rename_page(next(item for item in project.pages if item.id == page.id), name)))
    return {"error": None, "warnings": warnings, "state": doc_state()}


def doc_generate():
    """The open project's MicroPython code, without going through a file."""
    return generate(json.dumps(_doc().project.to_dict(), ensure_ascii=False, indent=2) + "\n")


# ---- The simulator (src/sim/): what runs in it comes from upstream, as on the desktop ----
SIM_PROJECT = "/sim/project"


def _files_under(directory):
    root = Path(directory)
    return [path.relative_to(root).as_posix() for path in sorted(root.rglob("*")) if path.is_file()]


def sim_project():
    """ui/main_run.py run_project: the open project generated for the simulator. The page reads the
    files from Pyodide's file system and runs them as upstream's runtime/web/lms_web.js does.
    compile_python is not called: mpy-cross for the browser is upstream request 2, and the
    runtime runs the .py files as they are."""
    from lvgl_mpy_studio.gen.project_gen import generate_project

    project = _doc().project
    shutil.rmtree(SIM_PROJECT, ignore_errors=True)
    generated = generate_project(project, SIM_PROJECT)
    return {
        "directory": SIM_PROJECT,
        "files": _files_under(SIM_PROJECT),
        "warnings": generated["warnings"],
        "width": project.display.width,
        "height": project.display.height,
        "board": project.board.get("id") if isinstance(project.board, dict) else "simulator",
    }


def sim_reset_folder(folder):
    """An empty folder in Pyodide's file system, for the flash the page copies in."""
    shutil.rmtree(folder, ignore_errors=True)
    Path(folder).mkdir(parents=True)


def sim_program(entry, flash):
    """ui/main_run.py run_program with build/program.py: the folder of entry copied over the
    program's flash, as an upload; the board every program runs as; the system files that
    build/web.py gives a program in the browser."""
    from lvgl_mpy_studio.build.program import copy_program, program_board
    from lvgl_mpy_studio.build.web import PROGRAM_SYSTEM
    from lvgl_mpy_studio.platform import root_dir

    entry = Path(entry)
    if entry.suffix != ".py" or not entry.is_file():  # as prepare_program
        raise ValueError(f"Not a Python file: {entry}")
    Path(flash).mkdir(parents=True, exist_ok=True)
    copy_program(entry.parent, Path(flash))
    board, width, height = program_board()
    system = root_dir() / "runtime" / "program"
    return {
        "files": _files_under(flash),
        "board": board,
        "width": width,
        "height": height,
        "entry": entry.name,
        "system": [str(system / name) for name in PROGRAM_SYSTEM],
    }


# ---- Code: the Code tab, modules, mpy-cross's errors, tracebacks (phase 4) ----
# mpy-cross runs in the page (WebAssembly, src/mpy/); its output comes back here, where upstream's
# own parse_compiler_errors, map_error and traceback_errors read it.
# ---- The designer (src/app/designer.ts): ui/designer/scene.py, ui/designer/preview.py ----
SIM_PREVIEW = "/sim/preview"


def _page_index(project, page_id):
    return next(index for index, page in enumerate(project.pages) if page.id == page_id)


def design_page(page_id):
    """What DesignerScene.rebuild puts on the canvas of a page: its widgets, components left
    out, parents before their children, each with the props WidgetItem paints from; and
    design_key, which changes only when what the page shows changes."""
    from lvgl_mpy_studio.build.preview import design_key
    from lvgl_mpy_studio.core.components import is_component

    project = _doc().project
    index = _page_index(project, page_id)
    page = project.pages[index]
    placed, items = set(), []
    pending = [widget for widget in page.widgets if not is_component(widget.type)]
    while pending:  # the order of rebuild: a widget waits for its container
        deferred = []
        for widget in pending:
            if widget.parentId and widget.parentId not in placed and any(item.id == widget.parentId for item in page.widgets):
                deferred.append(widget)
                continue
            placed.add(widget.id)
            items.append({
                "id": widget.id,
                "name": widget.name,
                "type": widget.type,
                "parentId": widget.parentId if widget.parentId in placed else None,
                "props": widget.props,
            })
        if len(deferred) == len(pending):  # a container that never comes: as rebuild, no parent
            for widget in deferred:
                items.append({"id": widget.id, "name": widget.name, "type": widget.type, "parentId": None, "props": widget.props})
            break
        pending = deferred
    return {
        "id": page.id,
        "name": page.name,
        "index": index,
        "display": {"width": project.display.width, "height": project.display.height},
        "designSize": list(page.designSize) if page.designSize else None,
        "widgets": items,
        "key": design_key(project, index),
    }


def design_tree():
    """ui/main_tree.py rebuild_project_tree and ComponentTray.rebuild: each page with its widgets
    in page order, and the non-visual components of the project."""
    from lvgl_mpy_studio.core.components import is_component
    from lvgl_mpy_studio.core.events import events_for

    project = _doc().project
    return {
        "pages": [
            {"id": page.id, "name": page.name, "widgets": [{"name": widget.name, "type": widget.type, "component": is_component(widget.type)} for widget in page.widgets]}
            for page in project.pages
        ],
        "components": [{"name": widget.name, "type": widget.type, "events": bool(events_for(widget.type))} for widget in project.widgets if is_component(widget.type)],
    }


def widget_handler(name):
    """The handler that ui/code/editor.py open_handler shows for a widget: the one of its default
    event, or else its first one; None when it has none yet."""
    from lvgl_mpy_studio.core.events import default_event, handler_name

    project = _doc().project
    widget = project.find_widget(name)
    if widget is None:
        return None
    handlers = project.code.handlers
    preferred = handler_name(name, default_event(widget.type))
    if preferred in handlers:
        return preferred
    return next((key for key, handler in handlers.items() if handler.widget == name), None)


def doc_add_page():
    """ui/main_tree.py add_page."""
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    name = f"page{len(document.project.pages) + 1}"
    document.execute(tr("Add Page"), lambda project: project.pages.append(project.new_page(name)))
    return doc_state()


def doc_delete_page(page_id):
    """ui/main_tree.py delete_page: the last page stays."""
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    if len(document.project.pages) == 1:
        return {"error": tr("The last page cannot be deleted"), "state": doc_state()}
    document.execute(tr("Delete Page"), lambda project: project.remove_page(next(item for item in project.pages if item.id == page_id)))
    return {"error": None, "state": doc_state()}


def doc_initial_page(page_id):
    """ui/main_tree.py set_initial_page: the page goes first and the app starts from it."""
    from lvgl_mpy_studio.core.i18n import tr

    def mutate(project):
        selected = next(item for item in project.pages if item.id == page_id)
        project.pages.remove(selected)
        project.pages.insert(0, selected)
        project.currentPageId = selected.id

    _doc().execute(tr("Initial Page"), mutate)
    return doc_state()


# ---- Editing on the canvas: ui/designer/scene.py DesignerScene, ui/main_window.py ----
CONTAINERS = {"obj", "panel", "tabview", "tileview", "window", "menu"}  # ui/designer/scene.py
TOOLBOX_NAMES = {"Basic": "Basic", "Input": "Input", "Display": "Display", "Data": "Data", "Media": "Media", "Navigation": "Navigation", "Container": "Containers", "Components": "Components", "Hardware": "Hardware"}


def _snapped(value, grid):
    """ui/designer/scene.py snapped."""
    return round(value / grid) * grid if grid > 1 else round(value)


def _page(project, page_id):
    return next(page for page in project.pages if page.id == page_id)


def toolbox():
    """Toolbox.populate: the widgets and components by category, with their names."""
    from lvgl_mpy_studio.core.components import is_component
    from lvgl_mpy_studio.core.i18n import tr

    categories = {}
    for widget_type, definition in _property_definitions().items():
        categories.setdefault(definition.get("category", "Basic"), []).append({"type": widget_type, "name": tr(definition.get("name", widget_type)), "component": is_component(widget_type)})
    return [{"category": category, "label": tr(TOOLBOX_NAMES.get(category, category)), "entries": entries} for category, entries in categories.items()]


def design_default_size(widget_type):
    """The size a new widget gets, for the drop preview (show_drop_preview, _centered)."""
    from lvgl_mpy_studio.core.components import is_component

    if is_component(widget_type):
        return None
    definition = _property_definitions()[widget_type]
    return {"name": definition.get("name", widget_type), "props": copy.deepcopy(definition.get("defaultProps") or {})}


def design_add_widget(page_id, widget_type, x, y, parent_id=None, centered=False, grid=1):
    """DesignerScene.add_widget: a component goes to the page as add_component; a widget goes
    inside the container under the point, if it is one, at the point (centred on a drop)."""
    from lvgl_mpy_studio.core.components import is_component
    from lvgl_mpy_studio.core.model import widget_definitions

    document = _doc()
    created = []
    if is_component(widget_type):
        document.execute("Add component", lambda project: project.add_widget(_page(project, page_id), widget_type))
        return {"created": [], "state": doc_state()}  # a component is not selected on the canvas
    parent = next((widget for widget in _page(document.project, page_id).widgets if widget.id == parent_id), None)
    if parent is not None and parent.type not in CONTAINERS:
        parent = None
    if parent is not None:  # mapFromScene: into the container's coordinates
        left, top = document.project.screen_position(parent)
        x, y = x - left, y - top
    if centered:  # _centered
        defaults = widget_definitions()[widget_type].get("defaultProps") or {}
        x, y = max(0, x - defaults.get("width", 100) / 2), max(0, y - defaults.get("height", 40) / 2)

    def mutate(project):
        widget = project.add_widget(_page(project, page_id), widget_type, {"x": _snapped(x, grid), "y": _snapped(y, grid)})
        if parent is not None:
            widget.parentId = parent.id
        created.append(widget.name)

    document.execute("Add Widget", mutate)
    return {"created": created, "state": doc_state()}


def design_delete(names):
    """DesignerScene.delete_selected, and the Delete key of the Components strip."""
    if names:
        _doc().execute("Delete Widget", lambda project: [project.remove_widget(name) for name in names])
    return doc_state()


def design_move(names, dx, dy):
    """DesignerScene.move_selected: the arrow keys."""
    if names:
        def mutate(project):
            for name in names:
                widget = project.find_widget(name)
                widget.props["x"] = int(widget.props.get("x", 0)) + dx
                widget.props["y"] = int(widget.props.get("y", 0)) + dy

        _doc().execute("Sposta widget", mutate)  # upstream's own description
    return doc_state()


def design_geometry(changed):
    """DesignerScene.commit_items: the geometries of a drag or a resize, in one step."""
    if changed:
        def mutate(project):
            for widget in project.widgets:
                if widget.id in changed:
                    widget.props.update(changed[widget.id])

        _doc().execute("Change Geometry", mutate)
    return doc_state()


def design_copy(page_id, names, cut=False):
    """DesignerScene.copy_selected: a container goes with what it contains."""
    document = _doc()
    project = document.project
    page = _page(project, page_id)
    selected = set(names)
    inside = {item.id for widget in page.widgets if widget.name in selected for item in project.subtree(widget)}
    document.clipboard = copy.deepcopy([widget.to_dict() for widget in page.widgets if widget.id in inside])
    if cut and selected:
        return design_delete(names)
    return doc_state()


def design_paste(page_id):
    """DesignerScene.paste: new names; a widget keeps its place inside a container pasted with it,
    the others move by 12 pixels."""
    document = _doc()
    if not document.clipboard:
        return {"created": [], "state": doc_state()}
    source = copy.deepcopy(document.clipboard)
    created = []

    def mutate(project):
        page = _page(project, page_id)
        id_map = {}
        for raw in source:
            widget = project.add_widget(page, raw["type"], raw.get("props"))
            widget.customStyles = copy.deepcopy(raw.get("customStyles") or {})
            widget.animations = copy.deepcopy(raw.get("animations") or [])
            widget.binding = copy.deepcopy(raw.get("binding"))
            id_map[raw["id"]] = widget.id
            created.append(widget.name)
        for raw, widget in zip(source, [project.find_widget(name) for name in created]):
            parent_id = raw.get("parentId")
            if parent_id in id_map:
                widget.parentId = id_map[parent_id]
                continue
            if any(candidate.id == parent_id for candidate in page.widgets):
                widget.parentId = parent_id
            widget.props["x"] = int(widget.props.get("x", 0)) + 12
            widget.props["y"] = int(widget.props.get("y", 0)) + 12

    document.execute("Paste Widgets", mutate)
    return {"created": created, "state": doc_state()}


def design_duplicate(page_id, names):
    """DesignerScene.duplicate_selected: copy and paste, the clipboard left as it was."""
    document = _doc()
    clipboard = document.clipboard
    design_copy(page_id, names)
    result = design_paste(page_id)
    document.clipboard = clipboard
    return result


def _selected_group(project, page_id, names):
    """DesignerScene._selected_group: a child of a selected container moves with it."""
    page = _page(project, page_id)
    selected = [widget for widget in page.widgets if widget.name in set(names)]
    ids = {widget.id for widget in selected}
    return [widget for widget in selected if widget.parentId not in ids]


def _parent_offset(project, widget, axis):
    parent = next((item for item in project.widgets if item.id == widget.parentId), None)
    if parent is None:
        return 0
    x, y = project.screen_position(parent)
    return int(x if axis == "x" else y)


def design_align(page_id, names, side):
    """DesignerScene.align_selected."""
    project = _doc().project
    items = _selected_group(project, page_id, names)
    if len(items) < 2:
        return doc_state()
    axis, size = ("x", "width") if side in ("left", "center", "right") else ("y", "height")
    starts = [item.props[axis] + _parent_offset(project, item, axis) for item in items]
    ends = [start + item.props[size] for start, item in zip(starts, items)]
    positions = {}
    for item in items:
        if side in ("left", "top"):
            value = min(starts)
        elif side in ("right", "bottom"):
            value = max(ends) - item.props[size]
        else:
            value = (min(starts) + max(ends) - item.props[size]) // 2
        positions[item.id] = {axis: value - _parent_offset(project, item, axis)}
    return _apply_positions("Align widgets", positions)


def design_distribute(page_id, names, axis):
    """DesignerScene.distribute_selected."""
    project = _doc().project
    items = _selected_group(project, page_id, names)
    if len(items) < 3:
        return doc_state()
    key, size = ("x", "width") if axis == "horizontal" else ("y", "height")
    absolute = lambda item: item.props[key] + _parent_offset(project, item, key)  # noqa: E731
    ordered = sorted(items, key=absolute)
    start, end = absolute(ordered[0]), absolute(ordered[-1]) + ordered[-1].props[size]
    gap = (end - start - sum(item.props[size] for item in ordered)) / (len(ordered) - 1)
    positions, cursor = {}, float(start)
    for item in ordered:
        positions[item.id] = {key: round(cursor) - _parent_offset(project, item, key)}
        cursor += item.props[size] + gap
    return _apply_positions("Distribute widgets", positions)


def _apply_positions(description, positions):
    def mutate(project):
        for widget in project.widgets:
            if widget.id in positions:
                widget.props.update(positions[widget.id])

    _doc().execute(description, mutate)
    return doc_state()


def design_z(page_id, names, front):
    """DesignerScene.change_z: Bring to Front, Send to Back."""
    if names:
        def mutate(project):
            page = _page(project, page_id)
            for name in names:
                widget = project.find_widget(name)
                page.widgets.remove(widget)
                if front:
                    page.widgets.append(widget)
                else:
                    page.widgets.insert(0, widget)

        _doc().execute("Widget Order", mutate)
    return doc_state()


def adapt_page_plan(page_id):
    """ui/main_resolution.py adapt_current_page before its question: only a page drawn for another
    resolution can be adapted."""
    project = _doc().project
    page = _page(project, page_id)
    return {"designSize": list(page.designSize) if page.designSize else None, "display": {"width": project.display.width, "height": project.display.height}}


def doc_adapt_page(page_id, mode):
    """adapt_current_page after the question: one undo step, then _report_outside."""
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    document.execute(tr("Adapt Page to Resolution"), lambda project: project.adapt_page(_page(project, page_id), mode))
    display = document.project.display
    return {"outside": document.project.widgets_outside(display.width, display.height), "state": doc_state()}


# ---- Project settings and board profiles: ui/project_settings.py, ui/profile_manager.py ----


def _profile_store():
    from lvgl_mpy_studio.core.boards import ProfileStore

    return ProfileStore.tolerant()


def config_dir():
    """platform.config_dir: where board profiles and blocks are kept; the page mirrors it."""
    from lvgl_mpy_studio.platform import config_dir as upstream_config_dir

    folder = upstream_config_dir()
    folder.mkdir(parents=True, exist_ok=True)
    return str(folder)


def config_files():
    """The files of the configuration folder, for the page to keep."""
    return _files_under(config_dir())


def config_reload():
    """After the page put the kept files back: the blocks read again, as at start-up."""
    from lvgl_mpy_studio.core import components

    carried = {"assets": {"blocks": {block.id: block.to_dict() for block in components.BLOCKS.values() if block.origin == "project"}}}
    components.reload_blocks()
    components.register_project_blocks(carried)
    return True


def project_settings_view():
    """ProjectSettingsDialog: the presets (common sizes and those of the boards), the profiles
    with the project's own copy first, the resolution diagnostics."""
    from lvgl_mpy_studio.core.i18n import tr

    project = _doc().project
    profiles = _profile_store().profiles()
    boards = {}
    for profile in profiles:
        boards.setdefault((profile["logicalWidth"], profile["logicalHeight"]), []).append(_board_name(profile))
    presets = [{"width": size[0], "height": size[1], "label": f"{size[0]}×{size[1]}" + (f" — {', '.join(boards[size])}" if size in boards else "")} for size in sorted(set(COMMON_SIZES) | set(boards))]
    choices = []
    if project.board:
        current = copy.deepcopy(project.board)
        current["origin"] = "project"
        choices.append(current)
    choices += profiles

    def info(profile):
        return tr("Physical display: {physical} — UI resolution: {logical} — Hardware scale: {scale}×", physical=f"{profile['physicalWidth']}×{profile['physicalHeight']}", logical=f"{profile['logicalWidth']}×{profile['logicalHeight']}", scale=profile["scale"])

    return {
        "presets": presets,
        "profiles": [{"key": f"{index}", "name": profile["name"], "width": profile["logicalWidth"], "height": profile["logicalHeight"], "info": info(profile)} for index, profile in enumerate(choices)],
        "current": "0" if project.board else None,
        "display": {"width": project.display.width, "height": project.display.height},
        "diagnostics": project.resolution_diagnostics(),
    }


def doc_project_settings(width, height, profile_key, mode):
    """open_project_settings after its dialogs: the resolution and the board in one step."""
    from lvgl_mpy_studio.core.boards import portable_profile
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    project = document.project
    choices = ([copy.deepcopy(project.board)] if project.board else []) + _profile_store().profiles()
    profile = choices[int(profile_key)] if profile_key is not None else None

    def mutate(project):
        project.resize(width, height, mode)
        project.board = copy.deepcopy(portable_profile(profile))

    document.execute(tr("Change Project Settings"), mutate)
    return {"outside": document.project.widgets_outside(width, height), "state": doc_state()}


def doc_update_profile():
    """ui/main_resolution.py update_project_profile: the project's copy from the catalog."""
    from lvgl_mpy_studio.core.boards import portable_profile, validate_profile
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    current = document.project.board
    profile = _profile_store().get(current["id"]) if current else None
    if not current or not profile:
        return {"error": tr("The profile is not in the catalog; the project's portable copy remains available."), "state": doc_state()}
    try:
        validate_profile(profile)
    except ValueError as exc:
        return {"error": str(exc), "state": doc_state()}

    def mutate(project):
        project.board = portable_profile(profile)
        project.scale_to(profile["logicalWidth"], profile["logicalHeight"])

    document.execute(tr("Update Project Profile"), mutate)
    return {"error": None, "state": doc_state()}


def profiles_manager():
    """ProfileManagerDialog: the profiles with their state, the adapters, the store's snapshot."""
    from lvgl_mpy_studio.core.boards import ADAPTERS, profile_diagnostics

    store = _profile_store()
    profiles = store.profiles()
    return {"profiles": [{**profile, "diagnostics": profile_diagnostics(profile)} for profile in profiles], "adapters": sorted(ADAPTERS), "loadError": store.load_error}


def profile_new(source=None):
    """ProfileManagerDialog.new and duplicate: a custom profile with a new id."""
    profile = _profile_store().new_profile(source)
    profile["origin"] = "custom"
    return profile


def profile_check(profile):
    """profile_diagnostics, for the dialog's messages."""
    from lvgl_mpy_studio.core.boards import profile_diagnostics

    return profile_diagnostics(profile)


def profile_default(profile_id):
    """ProfileManagerDialog.restore_default: the built-in profile as shipped."""
    from lvgl_mpy_studio.core.boards import builtin_profiles

    defaults = {item["id"]: item for item in builtin_profiles()}
    if profile_id not in defaults:
        return None
    restored = copy.deepcopy(defaults[profile_id])
    restored["origin"] = "builtin"
    return restored


def profiles_hidden():
    """ProfileManagerDialog.restore_hidden: the built-in profiles, as customised if they were."""
    from lvgl_mpy_studio.core.boards import builtin_profiles

    customized = _profile_store().snapshot()["custom"]
    restored = []
    for default in builtin_profiles():
        profile = copy.deepcopy(customized.get(default["id"], default))
        profile["origin"] = "custom" if default["id"] in customized else "builtin"
        restored.append(profile)
    return restored


def profiles_apply(profiles):
    """ProfileManagerDialog.apply_to_store: the custom profiles and the hidden built-in ones."""
    from lvgl_mpy_studio.core.boards import builtin_profiles, portable_profile

    store = _profile_store()
    custom = {profile["id"]: portable_profile(profile) for profile in profiles if profile.get("origin") == "custom"}
    ids = {profile["id"] for profile in profiles}
    hidden = [profile["id"] for profile in builtin_profiles() if profile["id"] not in ids]
    previous = store.snapshot()
    store.restore({"custom": custom, "hidden": hidden})
    try:
        store.save()
    except Exception:
        store.restore(previous)
        raise
    return True


# ---- The Block Manager: ui/blocks_manager.py ----
BLOCK_ORIGINS = {"standard": "Shipped with the IDE", "user": "Installed by you", "project": "Only inside this project"}
BLOCK_SOURCE = "/tmp/block-source"


def _used_blocks(project):
    """ui/blocks_manager.py used_blocks."""
    from lvgl_mpy_studio.core import components

    used = {}
    for widget in project.widgets:
        if components.block_for(widget.type) is not None:
            used.setdefault(widget.type, []).append(widget.name)
    return used


def blocks_view():
    """BlocksDialog.populate and _show_selected: each block with its details, the problems."""
    from lvgl_mpy_studio.core import components
    from lvgl_mpy_studio.core.i18n import tr

    used = _used_blocks(_doc().project)
    rows = []
    for block in sorted(components.BLOCKS.values(), key=lambda item: (item.origin != "standard", item.manifest["name"].lower())):
        manifest = block.manifest
        details = [tr(manifest["description"])]
        if manifest["properties"]:
            details.append(tr("Properties") + ": " + ", ".join(item["name"] for item in manifest["properties"]))
        if manifest["methods"]:
            details.append(tr("Methods") + ": " + ", ".join(f"{item['name']}({item.get('arguments', '')})" for item in manifest["methods"]))
        if manifest["events"]:
            details.append(tr("Events") + ": " + ", ".join(item["name"] for item in manifest["events"]))
        details.append(tr("In the simulator") + ": " + (tr("its own module") if manifest.get("simulator") else tr("a stand-in whose methods do nothing")))
        rows.append({
            "id": block.id, "name": tr(manifest["name"]), "version": manifest["version"], "origin": block.origin,
            "originLabel": tr(BLOCK_ORIGINS[block.origin]), "author": manifest["author"], "license": manifest["license"],
            "usedBy": used.get(block.id, []), "details": details,
        })
    problems = [tr("Not loaded: {folder} — {reason}", folder=folder, reason=reason) for folder, reason in components.PROBLEMS]
    return {"blocks": rows, "problems": problems}


def _blocks_changed(select=None):
    """BlocksDialog._changed: the blocks read again, keeping those the open project carries."""
    config_reload()
    return {"select": select, **blocks_view()}


def block_source_folder():
    """An empty folder where the page copies the block the user chose."""
    shutil.rmtree(BLOCK_SOURCE, ignore_errors=True)
    Path(BLOCK_SOURCE).mkdir(parents=True)
    return BLOCK_SOURCE


def block_check(source=BLOCK_SOURCE):
    """BlocksDialog.install_folder before installing: the folder is a block, not the Timer, and
    the question when one with its id is there already."""
    from lvgl_mpy_studio.core import blocks, components
    from lvgl_mpy_studio.core.i18n import tr

    try:
        candidate = blocks.load_block(source, "user", check_name=False)
    except blocks.BlockError as exc:
        return {"error": tr("This folder is not a block that can be used: {reason}", reason=exc)}
    if candidate.id == "timer":
        return {"error": tr("“timer” is the name of the built-in Timer: the block needs another id.")}
    existing = components.BLOCKS.get(candidate.id)
    question = tr("The block {name} {version} is already there ({origin}). Replace it with version {new}?", name=existing.manifest["name"], version=existing.manifest["version"], origin=tr(BLOCK_ORIGINS[existing.origin]), new=candidate.manifest["version"]) if existing is not None else None
    return {"error": None, "id": candidate.id, "question": question}


def block_install(source=BLOCK_SOURCE):
    """blocks.install_block, into the blocks folder of the configuration."""
    from lvgl_mpy_studio.core import blocks

    candidate = blocks.load_block(source, "user", check_name=False)
    blocks.install_block(source)
    return _blocks_changed(candidate.id)


def block_install_project(block_id):
    """BlocksDialog.install_selected: a block the project carries, installed for every project."""
    from lvgl_mpy_studio.core import blocks, components

    block = components.BLOCKS.get(block_id)
    if block is None or block.origin != "project":
        return _blocks_changed()
    blocks.write_block(block)
    return _blocks_changed(block_id)


def block_remove_question(block_id):
    from lvgl_mpy_studio.core import components
    from lvgl_mpy_studio.core.i18n import tr

    block = components.BLOCKS[block_id]
    users = _used_blocks(_doc().project).get(block_id, [])
    question = tr("Remove the block {name} from this computer?", name=tr(block.manifest["name"]))
    if users:
        question += "\n\n" + tr("The open project uses it ({names}): it keeps working with the copy inside the project.", names=", ".join(users))
    return question


def block_remove(block_id):
    """BlocksDialog.remove_selected after its question: the project keeps its copy if it uses it."""
    from lvgl_mpy_studio.core import blocks, components

    block = components.BLOCKS.get(block_id)
    if block is None or block.origin != "user":
        return _blocks_changed()
    users = _used_blocks(_doc().project).get(block.id, [])
    kept = {"assets": {"blocks": {block.id: block.to_dict()}}} if users else {}
    blocks.remove_block(block.id)
    components.reload_blocks()
    components.register_project_blocks(kept)
    return _blocks_changed()


# ---- The budget in the status bar: build/budget.py measure_budget, ui/budget.py ----
# measure_budget starts mpy-cross and the runtime as processes. In the browser the page compiles
# first, with mpy-cross in WebAssembly, every file measure_budget will compile, and runs the
# instrumented app in the simulator afterwards. measure_budget itself runs unchanged, with its
# two process calls answered from what the page compiled.
BUDGET = "/sim/budget"
BUDGET_CACHE = "/sim/budget-cache"
BUDGET_RAM = "/sim/budget-ram"


def _budget_key(data, args):
    import hashlib

    return hashlib.sha256(data + b"\0" + " ".join(args).encode()).hexdigest()


def budget_prepare(board_mpy=None):
    """The files measure_budget compiles: the generated project, and the board's files when the
    project names a compatible board. The page compiles each one into the cache."""
    from lvgl_mpy_studio.core.boards import compatible, portable_profile
    from lvgl_mpy_studio.gen.board_gen import PRECOMPILED, generate_board
    from lvgl_mpy_studio.gen.project_gen import generate_project

    project = _doc().project
    shutil.rmtree(BUDGET, ignore_errors=True)
    shutil.rmtree(BUDGET_CACHE, ignore_errors=True)
    Path(BUDGET_CACHE).mkdir(parents=True)
    jobs = []
    try:
        generate_project(project, f"{BUDGET}/simulator")
    except (OSError, ValueError):
        return {"jobs": [], "cache": BUDGET_CACHE}
    for path in sorted(Path(f"{BUDGET}/simulator").glob("*.py")):
        jobs.append({"path": str(path), "name": path.name, "args": [], "key": _budget_key(path.read_bytes(), [])})
    if project.board and compatible(project, project.board):
        try:
            generated = generate_board(project, portable_profile(project.board), f"{BUDGET}/board")
        except (OSError, ValueError):
            generated = {"files": []}
        for name in (item for item in generated.get("precompile", PRECOMPILED) if item in generated["files"]):
            path = Path(f"{BUDGET}/board") / name
            jobs.append({"path": str(path), "name": name, "args": ["-s", name], "key": _budget_key(path.read_bytes(), ["-s", name])})
    return {"jobs": jobs, "cache": BUDGET_CACHE}


def _cached(path, args, cache=BUDGET_CACHE):
    """What the page compiled for this file: (.mpy bytes or None, output)."""
    key = _budget_key(Path(path).read_bytes(), args)
    mpy, output = Path(cache) / f"{key}.mpy", Path(cache) / f"{key}.out"
    return (mpy.read_bytes() if mpy.exists() else None), (output.read_text(encoding="utf-8") if output.exists() else "mpy-cross: not compiled")


def budget_measure(board_mpy=None):
    """measure_budget, with compile_python and _bytecode_file answered from the cache and the RAM
    run left to the page: the app instrumented by upstream's _instrument, in a folder to run."""
    from lvgl_mpy_studio.build import budget, compiler
    from lvgl_mpy_studio.gen import board_gen

    def compile_python(directory, mpy_cross=None):
        directory = Path(directory)
        errors = []
        for path in sorted(directory.glob("*.py")):
            mpy, output = _cached(path, [])
            if mpy is None:
                errors.extend(compiler.parse_compiler_errors(output, directory))
            else:
                path.with_suffix(".mpy").write_bytes(mpy)
        if errors:
            raise compiler.CompileError(errors)
        return True

    def bytecode_file(source, target):
        mpy, _output = _cached(source, ["-s", Path(source).name])
        if mpy is None:
            return None
        Path(target).write_bytes(mpy)
        return mpy

    ram = {}

    def measure_ram(directory):
        main = Path(directory) / "main.py"
        source = budget._instrument(main.read_text(encoding="utf-8"))
        if source is None:
            return None
        main.write_text(source, encoding="utf-8", newline="\n")
        shutil.rmtree(BUDGET_RAM, ignore_errors=True)
        shutil.copytree(directory, BUDGET_RAM)
        ram["ready"] = True
        return None

    saved = budget.compile_python, board_gen._bytecode_file, budget._measure_ram
    budget.compile_python, board_gen._bytecode_file, budget._measure_ram = compile_python, bytecode_file, measure_ram
    try:
        result = budget.measure_budget(_doc().project, board_mpy)
    finally:
        budget.compile_python, board_gen._bytecode_file, budget._measure_ram = saved
    if result is None:
        return None
    project = _doc().project
    return {
        "flash": result["flash"],
        "ram": None,
        "run": {"directory": BUDGET_RAM, "files": _files_under(BUDGET_RAM), "width": project.display.width, "height": project.display.height} if ram else None,
        "marker": budget.MARKER,
        "settle": budget.SETTLE_LOOPS,
    }


# ---- The web version: ui/main_files.py open_in_browser and program_in_browser (phase 7) ----
# build/web.py runs unchanged; only compile_python is answered from compilations the page made
# first with mpy-cross in WebAssembly, as for the budget. The page puts the runtime where
# web_runtime() looks for it, and reads the folder built.
WEB = "/web"
WEB_CACHE = "/web/cache"
WEB_DIST = "/web/dist"


def web_runtime_dir():
    """Where build/web.py takes micropython.mjs and .wasm from: the page writes them there."""
    from lvgl_mpy_studio.build.web import web_runtime

    return str(web_runtime())


def web_prepare():
    """The files build_web's compile_python will compile: the project generated, as build_web
    generates it. The page compiles each one into the cache."""
    from lvgl_mpy_studio.gen.project_gen import generate_project

    shutil.rmtree(WEB, ignore_errors=True)
    Path(WEB_CACHE).mkdir(parents=True)
    generate_project(_doc().project, f"{WEB}/check")
    jobs = [{"path": str(path), "name": path.name, "args": [], "key": _budget_key(path.read_bytes(), [])} for path in sorted(Path(f"{WEB}/check").glob("*.py"))]
    return {"jobs": jobs, "cache": WEB_CACHE}


def web_build():
    """build_web on the open project, compile_python answered from the cache."""
    from lvgl_mpy_studio.build import compiler, web

    def compile_python(directory, mpy_cross=None):
        directory = Path(directory)
        errors = []
        for path in sorted(directory.glob("*.py")):
            mpy, output = _cached(path, [], WEB_CACHE)
            if mpy is None:
                errors.extend(compiler.parse_compiler_errors(output, directory))
            else:
                path.with_suffix(".mpy").write_bytes(mpy)
        if errors:
            raise compiler.CompileError(errors)
        return True

    saved = web.compile_python
    web.compile_python = compile_python
    try:
        target = web.build_web(copy.deepcopy(_doc().project), WEB_DIST)
    finally:
        web.compile_python = saved
    return {"directory": str(target), "name": target.name, "files": _files_under(target)}


def program_web(entry):
    """program_in_browser: build_program_web on a program the page copied into Python, with the
    board every program runs as."""
    from lvgl_mpy_studio.build.program import program_board
    from lvgl_mpy_studio.build.web import build_program_web

    shutil.rmtree(WEB_DIST, ignore_errors=True)
    board, width, height = program_board()
    target = build_program_web(Path(entry), WEB_DIST, width, height, board)
    return {"directory": str(target), "name": target.name, "files": _files_under(target)}


def budget_texts(budget_value, limits):
    """ui/budget.py budget_text and budget_level, and the tooltip of MainWindow._show_budget."""
    from lvgl_mpy_studio.core.i18n import tr

    ratio = 0.8  # ui/budget.py WARNING_RATIO

    def size(value):
        return f"{value / 1024:.0f} KB" if value < 1024 * 1024 else f"{value / (1024 * 1024):.1f} MB"

    if budget_value is None:
        text = tr("Flash — · RAM —")
        level = 0
    else:
        def part(key):
            value = budget_value.get(key)
            if value is None:
                return "—"
            return f"{size(value)} / {size(limits[key])}" if limits.get(key) else size(value)

        text = tr("Flash {flash} · RAM ~{ram}", flash=part("flash"), ram=part("ram"))
        ratios = [budget_value[key] / limits[key] for key in ("flash", "ram") if budget_value.get(key) is not None and limits.get(key)]
        worst = max(ratios, default=0)
        level = 2 if worst > 1 else 1 if worst >= ratio else 0
    # upstream says "the 64-bit simulator": here it is the 32-bit WebAssembly one
    tip = tr("Flash: files that would go on the board. RAM: measured in the WebAssembly simulator, without video buffers.")
    tip += "\n" + (tr("Limits are the free memory read from the board at the last connection.") if limits else tr("Connect the board to compare these values with the available memory."))
    return {"text": text, "level": level, "tooltip": tip}


# ---- Fonts: lvgl_mpy_studio/fontconv.py, which is Qt, answered by the page ----
# gen/fonts.py imports lvgl_mpy_studio.fontconv only to call convert(data, size, characters).
# Here that module is one of this file's: convert answers from the glyphs the page rasterised
# (src/fonts/rasterise.ts) and writes them with upstream's own gen/binfont.py. Before each call
# that generates code, the page asks fonts_needed and converts what is missing.
FONTS = "/sim/fonts"
_glyphs = {}


def _font_key(data, size, characters):
    import hashlib

    return f"{hashlib.sha256(bytes(data)).hexdigest()}:{size}:{hashlib.sha256(characters.encode()).hexdigest()[:16]}"


def _fontconv_convert(data, size, characters):
    """fontconv.convert: {"output", "missing"} or {"error"}."""
    from lvgl_mpy_studio.gen.binfont import write_binfont

    found = _glyphs.get(_font_key(data, size, characters))
    if found is None:
        return {"error": "the font was not converted yet"}
    if found.get("error"):
        return {"error": found["error"]}
    font = found["font"]
    glyphs = [{**glyph, "pixels": bytes(glyph["pixels"])} for glyph in font["glyphs"]]
    if not glyphs:
        return {"error": "the font has none of the characters used"}
    kerning = {tuple(int(code) for code in pair.split(",")): value for pair, value in font["kerning"].items()}
    return {"output": write_binfont({**font, "glyphs": glyphs, "kerning": kerning}), "missing": found["missing"]}


def _install_fontconv():
    import types

    module = types.ModuleType("lvgl_mpy_studio.fontconv")
    module.__doc__ = "lvgl_mpy_studio.fontconv for the browser: see py/lms_bridge.py"
    module.convert = _fontconv_convert
    sys.modules["lvgl_mpy_studio.fontconv"] = module


_install_fontconv()


def fonts_needed():
    """The fonts the open project asks for, at each size, that the page has not converted yet:
    gen/fonts.py convert_fonts's requests."""
    import base64

    from lvgl_mpy_studio.gen.gen_python import build_project_code
    from lvgl_mpy_studio.gen.project_gen import legacy_data

    project = _doc().project
    if not (project.assets or {}).get("fonts"):
        return []
    needed = []
    Path(FONTS).mkdir(parents=True, exist_ok=True)
    for request in build_project_code(legacy_data(project))["fontRequests"]:
        try:
            data = base64.b64decode(str(request["data"]).split(",", 1)[-1], validate=True)
        except ValueError:
            continue
        key = _font_key(data, request["size"], request["characters"])
        if key in _glyphs:
            continue
        path = f"{FONTS}/{key.split(':')[0]}.font"
        if not Path(path).exists():
            Path(path).write_bytes(data)
        needed.append({"key": key, "path": path, "size": request["size"], "characters": request["characters"]})
    return needed


def fonts_put(key, font=None, missing="", error=None):
    """What the page made of a request; upstream's cache of conversions is emptied, so that a
    conversion asked before it was ready is asked again."""
    from lvgl_mpy_studio.gen import fonts

    _glyphs[key] = {"font": font, "missing": missing, "error": error}
    fonts._cache.clear()
    return True


# ---- The Properties panel (src/ui/properties-panel.ts): ui/properties/panel.py ----
CATEGORIES = ("Identity", "Position", "Appearance", "Behavior")


def _display_value(value):
    """ui/properties/panel.py display_value."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    return str(value)


def _property_definitions():
    from lvgl_mpy_studio.core.components import COMPONENTS
    from lvgl_mpy_studio.core.model import widget_definitions

    return {**widget_definitions(), **COMPONENTS}  # MainWindow._blocks_changed reads them again


def _selected_widgets(names):
    project = _doc().project
    widgets = [project.find_widget(name) for name in names]
    return [widget for widget in widgets if widget is not None]


def _descriptors(widgets):
    """PropertiesPanel._descriptors: the properties the selected widgets have in common, in the
    order of the first one's definition, then the others alphabetically."""
    if not widgets:
        return []
    definitions_all = _property_definitions()
    common = None
    definitions = {}
    for widget in widgets:
        properties = definitions_all.get(widget.type, {}).get("properties") or []
        definitions[widget.type] = {item["name"]: item for item in properties}
        names = set(definitions[widget.type]) | set(widget.props)
        common = names if common is None else common & names
    first = list(definitions[widgets[0].type])
    ordered = [name for name in first if name in (common or ())] + sorted(set(common or ()) - set(first))
    return [copy.deepcopy(next((definitions[widget.type].get(name) for widget in widgets if definitions[widget.type].get(name)), {"name": name, "type": "string"})) for name in ordered]


def properties_view(names):
    """PropertiesPanel.rebuild: the rows of the selected widgets by category, and the Events tab
    for a single widget. The panel sorts them alphabetically when asked."""
    from lvgl_mpy_studio.core.assets import fonts
    from lvgl_mpy_studio.core.events import EVENTS, events_for
    from lvgl_mpy_studio.core.i18n import tr

    widgets = _selected_widgets(names)
    if not widgets:
        return {"names": [], "categories": [], "events": [], "fonts": []}
    rows = {"Identity": [{"name": "Name", "label": tr("Name"), "type": "name", "value": widgets[0].name if len(widgets) == 1 else "", "descriptor": {"name": "Name", "type": "name"}}]}
    for descriptor in _descriptors(widgets):
        name = descriptor["name"]
        category = "Position" if name in ("x", "y", "width", "height") else "Behavior" if name in ("value", "checked", "selected", "options", "min", "max", "period", "enabled") else "Appearance"
        values = [widget.props.get(name) for widget in widgets]
        value = values[0] if all(item == values[0] for item in values) else ""
        row = {"name": name, "label": tr(descriptor.get("label", name)), "type": descriptor.get("type", "string"), "value": _display_value(value), "descriptor": descriptor}
        if descriptor.get("type") == "boolean":
            row["checked"] = value is True
        rows.setdefault(category, []).append(row)
    events = []
    if len(widgets) == 1:
        widget = widgets[0]
        for name in events_for(widget.type):
            events.append({"event": name, "description": tr(EVENTS[name].description), "handler": widget.events.get(name, ""), "bound": name in widget.events})
    return {
        "names": [widget.name for widget in widgets],
        "categories": [{"name": category, "label": tr(category), "rows": rows[category]} for category in CATEGORIES if rows.get(category)],
        "events": events,
        "fonts": [item["name"] for item in fonts(_doc().project)],
    }


def properties_set(names, name, text, checked=None):
    """PropertiesPanel._item_changed, without the image and font files of sub-step 6: the name
    checked and the widget renamed, or the value read by its type and written to every selected
    widget, in one undo step. checked is the box of a boolean row."""
    from lvgl_mpy_studio.core.blocks import parse_pin
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.names import validate_name

    document = _doc()
    widgets = _selected_widgets(names)
    reply = {"error": None, "warnings": [], "names": [widget.name for widget in widgets]}
    if name == "Name":
        if len(widgets) != 1:
            return {**reply, "state": doc_state()}
        old_name = widgets[0].name
        if text == old_name:
            return {**reply, "state": doc_state()}
        error = validate_name(text, document.project.used_names - {old_name})
        if error:
            return {**reply, "error": error, "state": doc_state()}
        warnings = []
        document.execute(tr("Rename Widget"), lambda project: warnings.extend(project.rename_widget(old_name, text)))
        return {**reply, "warnings": warnings, "names": [text], "state": doc_state()}
    descriptor = next((item for item in _descriptors(widgets) if item["name"] == name), {"type": "string"})
    kind = descriptor.get("type")
    try:
        if kind == "number":
            value = int(text)
        elif kind == "pin":
            value = parse_pin(text)
        elif kind == "boolean":
            value = bool(checked) if checked is not None else text.lower() == "true"
        else:
            value = text
    except ValueError:
        return {**reply, "error": tr("Invalid value for {name}", name=name), "state": doc_state()}
    if all(widget.props.get(name) == value for widget in widgets) and all(name in widget.props for widget in widgets):
        return {**reply, "state": doc_state()}  # nothing changes: no undo step
    selected = [widget.name for widget in widgets]

    def mutate(project):
        for widget_name in selected:
            project.find_widget(widget_name).props[name] = value

    document.execute(tr("Change {name}", name=name), mutate)
    return {**reply, "state": doc_state()}


ASSET_UPLOAD = "/sim/asset"


def asset_upload_path():
    """Where the page writes a picture or a font file the user chose."""
    Path(ASSET_UPLOAD).parent.mkdir(parents=True, exist_ok=True)
    return ASSET_UPLOAD


def image_sizes():
    """core/assets.py images: the pictures of the project with their size."""
    from lvgl_mpy_studio.core.assets import images

    return [{"name": item["name"], "width": item["width"], "height": item["height"]} for item in images(_doc().project)]


def properties_set_asset(names, name, kind, file_name):
    """PropertiesPanel._item_changed for a file chosen with … next to an image or font property:
    the picture (already PNG and no larger than the screen, as _read_image makes it) or the font
    becomes part of the project, and the property names it, in one undo step."""
    from lvgl_mpy_studio.core.assets import AssetError, add_font, add_image, font_name, fonts, free_image_name
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.model import Project

    document = _doc()
    widgets = _selected_widgets(names)
    reply = {"error": None, "warnings": [], "names": [widget.name for widget in widgets]}
    data = Path(ASSET_UPLOAD).read_bytes()
    image = font = None
    try:
        if kind == "image":
            image = (free_image_name(document.project, file_name), data)
            add_image(Project(), *image)  # the checks, before anything changes
            value = image[0]
        else:
            value = font_name(file_name)
            existing = next((item["name"] for item in fonts(document.project) if item["name"] == value), None)
            font = (value, data) if existing is None else None
            if font:
                add_font(Project(), *font)
    except AssetError as exc:
        return {**reply, "error": str(exc), "state": doc_state()}
    selected = [widget.name for widget in widgets]

    def mutate(project):  # the desktop's macro: Add Image or Add Font, then Change <name>
        if image:
            add_image(project, *image)
        if font:
            add_font(project, *font)
        for widget_name in selected:
            project.find_widget(widget_name).props[name] = value

    document.execute(tr("Change {name}", name=name), mutate)
    return {**reply, "state": doc_state()}


def event_handler(widget_name, event):
    """PropertiesPanel._event_activated: the handler made if missing ("Create Handler"), its name."""
    from lvgl_mpy_studio.core.events import handler_name
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    document.execute(tr("Create Handler"), lambda project: project.ensure_handler(widget_name, event))  # as the desktop, also when it exists
    return {"handler": handler_name(widget_name, event), "state": doc_state()}


def design_preview(page_id, pending=None):
    """build/preview.py render_with_log up to the runtime: the page generated design-only, the
    project's code left out, in a folder the simulator's frame mode runs. pending holds the
    geometries of a drag not recorded yet, as MainWindow._preview_drag passes them."""
    from lvgl_mpy_studio.build.preview import design_key, prepare_page

    project = _doc().project
    if pending:
        project = copy.deepcopy(project)
        for widget in project.widgets:
            if widget.id in pending:
                widget.props.update(pending[widget.id])
    index = _page_index(project, page_id)
    shutil.rmtree(SIM_PREVIEW, ignore_errors=True)
    try:
        prepare_page(project, index, SIM_PREVIEW, design_only=True)
    except (OSError, ValueError) as exc:
        return {"error": str(exc), "key": design_key(project, index)}
    return {
        "directory": SIM_PREVIEW,
        "files": _files_under(SIM_PREVIEW),
        "width": project.display.width,
        "height": project.display.height,
        "board": project.board.get("id") if isinstance(project.board, dict) else "simulator",
        "key": design_key(project, index),
    }


COMMON_SIZES = ((240, 240), (480, 480), (1024, 600), (1024, 1024))  # ui/resolution.py


def _board_name(profile):
    """ui/resolution.py board_name, which sits in a module that imports Qt: the name without the
    resolution, if it already holds it."""
    size = f"({profile['logicalWidth']}×{profile['logicalHeight']})"
    return profile["name"].replace(size, "").strip() or profile["name"]


def resolution_menu():
    """ResolutionSelector.rebuild: the sizes of the board profiles with their names, the common
    sizes, the current size."""
    from lvgl_mpy_studio.core.boards import ProfileStore

    boards = {}
    for profile in ProfileStore.tolerant().profiles():
        boards.setdefault((profile["logicalWidth"], profile["logicalHeight"]), []).append(_board_name(profile))
    display = _doc().project.display
    return {
        "boards": [{"width": size[0], "height": size[1], "names": boards[size]} for size in sorted(boards)],
        "common": [{"width": width, "height": height} for width, height in COMMON_SIZES],
        "current": {"width": display.width, "height": display.height},
    }


def _unlinks_board(project, width, height):
    board = project.board
    return bool(board) and (board["logicalWidth"], board["logicalHeight"]) != (width, height)


def resolution_plan(width, height):
    """ui/main_resolution.py change_resolution before the dialog: the same size changes nothing;
    a board of another size is unlinked, and the dialog says so."""
    from lvgl_mpy_studio.core.i18n import tr

    project = _doc().project
    if (width, height) == (project.display.width, project.display.height):
        return {"same": True, "note": ""}
    board = project.board
    note = tr("The project uses the board {name} ({size}): it will be unlinked and the simulator selected.", name=_board_name(board), size=f"{board['logicalWidth']}×{board['logicalHeight']}") if _unlinks_board(project, width, height) else ""
    return {"same": False, "note": note}


def doc_change_resolution(width, height, mode):
    """change_resolution after the dialog: one undo step, then _report_outside."""
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    unlink = _unlinks_board(document.project, width, height)

    def mutate(project):
        project.resize(width, height, mode)
        if unlink:
            project.board = None
            project.runTarget = None

    document.execute(tr("Change Resolution"), mutate)
    return {"outside": document.project.widgets_outside(width, height), "state": doc_state()}


NEW_MODULE_SOURCE = "import lvgl as lv\nimport ui\n\n\n"  # ui/main_tree.py
CHECK_DIR = "/sim/check"
# ui/main_run.py TRACEBACK_BLOCK: a complete traceback, the frame lines, then the exception line.
TRACEBACK_BLOCK = re.compile(r"Traceback \(most recent call last\):\n(?:[ \t].*\n)+(\S.*)\n")


def syntax_errors(output, directory="/"):
    """ui/files.py syntax_errors, from mpy-cross's output: [{"line", "message"}]."""
    from lvgl_mpy_studio.build.compiler import parse_compiler_errors

    return [{"line": error["line"], "message": error.get("detail") or error["message"]} for error in parse_compiler_errors(output, directory)]


def lv_completions():
    """ui/files.py lvgl_completions: the names after `lv.`, from gen/completion.json."""
    from lvgl_mpy_studio.platform import root_dir

    api = json.loads((root_dir() / "lvgl_mpy_studio" / "gen" / "completion.json").read_text(encoding="utf-8"))
    return sorted({*api["constants"], *api["functions"], *api["objects"]})


def code_generate_check():
    """ui/code/editor.py check_syntax, first half: the open project generated, to be compiled."""
    from lvgl_mpy_studio.gen.project_gen import generate_project

    shutil.rmtree(CHECK_DIR, ignore_errors=True)
    generate_project(_doc().project, CHECK_DIR)
    return {"directory": CHECK_DIR, "files": sorted(path.name for path in Path(CHECK_DIR).glob("*.py"))}


def code_compile_errors(directory, outputs):
    """compile_python's errors, mapped as check_syntax and _show_compile_errors map them: outputs is
    {file name: mpy-cross output} of the files that did not compile."""
    from lvgl_mpy_studio.build.compiler import map_error, parse_compiler_errors

    modules = {module.name for module in _doc().project.modules}
    errors = []
    for name in sorted(outputs):
        errors.extend(parse_compiler_errors(outputs[name], directory))
    sourcemap = Path(directory) / "sourcemap.json"
    return [map_error(error, sourcemap, modules) if sourcemap.exists() else error for error in errors]


def code_trace_errors(text, directory=SIM_PROJECT):
    """ui/main_run.py _sim_output: the complete tracebacks in text, as rows of the Errors panel."""
    from lvgl_mpy_studio.build.compiler import traceback_errors
    from lvgl_mpy_studio.core.i18n import tr

    try:
        sourcemap = json.loads((Path(directory) / "sourcemap.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        sourcemap = None
    modules = {module.name for module in _doc().project.modules}
    rows = []
    for block in TRACEBACK_BLOCK.finditer(text.replace("\r\n", "\n")):
        exception = block.group(1).strip()
        errors = sorted(traceback_errors(block.group(0), sourcemap, modules), key=lambda error: not error.get("origin"))
        for mapped in errors:
            mapped["message"] = exception if mapped["origin"] else tr("called from here") + " — " + exception
            mapped["tooltip"] = block.group(0).strip()
            rows.append(mapped)
    return rows


def code_state():
    """What the Code tab lists: the general code, the handlers, the modules, with their text."""
    project = _doc().project
    return {
        "module": project.code.module,
        "handlers": [{"name": name, "widget": handler.widget, "event": handler.event, "body": handler.body} for name, handler in project.code.handlers.items()],
        "modules": [{"id": module.id, "name": module.name, "source": module.source} for module in project.modules],
    }


def code_set(kind, key, text, session=0, owner=None, event=None):
    """ui/code/editor.py _text_changed: one undo step per editing session (merge id 10000 + session).
    A handler not made yet (owner and event given, the key not among the handlers) is made by
    the first text typed, with ensure_handler."""
    from lvgl_mpy_studio.core.modules import set_module_source

    document = _doc()
    project = document.project
    code_only = True
    if kind == "module":
        mutator = lambda project: setattr(project.code, "module", text)  # noqa: E731
    elif kind == "pymodule":
        name = next(module.name for module in project.modules if module.id == key)
        mutator = lambda project: set_module_source(project, name, text)  # noqa: E731
    elif owner and key not in project.code.handlers:
        mutator = lambda project: setattr(project.ensure_handler(owner, event)[1], "body", text)  # noqa: E731
        code_only = False
    else:
        mutator = lambda project: setattr(project.code.handlers[key], "body", text)  # noqa: E731
    document.execute("Edit Code", mutator, 10000 + int(session), code_only)
    return doc_state()


def code_objects():
    """CodePanel.populate: the Object list. A key is module, pymodule:<id>, page:<name>,
    widget:<name> or orphan:<handler>."""
    from lvgl_mpy_studio.core.events import events_for
    from lvgl_mpy_studio.core.i18n import tr

    project = _doc().project
    objects = [{"key": "module", "label": tr("(General)")}]
    objects += [{"key": f"pymodule:{module.id}", "label": tr("Module: {name}", name=f"{module.name}.py")} for module in project.modules]
    objects += [{"key": f"page:{page.name}", "label": tr("Page: {name}", name=page.name)} for page in project.pages]
    objects += [{"key": f"widget:{widget.name}", "label": f"{widget.name} ({widget.type})"} for widget in project.widgets if events_for(widget.type)]
    page_names = {page.name for page in project.pages}
    objects += [{"key": f"orphan:{name}", "label": tr("Orphan: {name}", name=name)} for name, handler in project.code.handlers.items() if not project.find_widget(handler.widget) and handler.widget not in page_names]
    return objects


def code_object_of(handler):
    """CodePanel.populate: the object a handler belongs to."""
    project = _doc().project
    found = project.code.handlers.get(handler)
    if found is None:
        return None
    if project.find_widget(found.widget):
        return f"widget:{found.widget}"
    if found.widget in {page.name for page in project.pages}:
        return f"page:{found.widget}"
    return f"orphan:{handler}"


def code_procedures(key):
    """CodePanel._load_object: the Procedure list of an object, with the handler of each event,
    whether it exists, and the one chosen by default."""
    from lvgl_mpy_studio.core.events import PAGE_EVENTS, default_event, events_for, handler_name
    from lvgl_mpy_studio.core.i18n import tr

    project = _doc().project
    kind, _, name = key.partition(":")
    if kind == "module":
        return {"procedures": [{"event": tr("(Declarations)"), "handler": "module", "exists": True}], "default": "module"}
    if kind == "pymodule":
        return {"procedures": [{"event": tr("(Module)"), "handler": "pymodule", "exists": True}], "default": "pymodule"}
    if kind == "orphan":
        handler = project.code.handlers.get(name)
        return {"procedures": [{"event": handler.event if handler else "", "handler": name, "exists": True}], "default": name}
    if kind == "page":
        extra = [handler.event for handler in project.code.handlers.values() if handler.widget == name and handler.event not in PAGE_EVENTS and not project.find_widget(name)]
        events = [*PAGE_EVENTS, *dict.fromkeys(extra)]
        default = None
    else:
        widget = project.find_widget(name)
        events = events_for(widget.type)
        default = handler_name(name, default_event(widget.type))
    procedures = [{"event": event, "handler": handler_name(name, event), "exists": handler_name(name, event) in project.code.handlers} for event in events]
    return {"procedures": procedures, "default": default or (procedures[0]["handler"] if procedures else None)}


def code_open(key, handler):
    """CodePanel._load_body: the text and the signature line of what is chosen. A handler of an
    object made again with the same name is attached to it again ("Create Handler")."""
    from lvgl_mpy_studio.core.i18n import tr

    document = _doc()
    project = document.project
    kind, _, name = key.partition(":")
    if kind == "module":
        return {"current": {"kind": "module"}, "body": project.code.module, "signature": "' " + tr("(General)"), "state": doc_state()}
    if kind == "pymodule":
        module = next(module for module in project.modules if module.id == name)
        return {"current": {"kind": "pymodule", "id": name}, "body": module.source, "signature": "' " + tr("{file}: imported with import {name}", file=f"{module.name}.py", name=module.name), "state": doc_state()}
    if kind == "orphan":
        found = project.code.handlers[handler]
        return {"current": {"kind": "handler", "name": handler}, "body": found.body, "signature": f"def {handler}(e):  ' " + tr("orphan handler"), "state": doc_state()}
    event = next((item["event"] for item in code_procedures(key)["procedures"] if item["handler"] == handler), None)
    existing = project.code.handlers.get(handler)
    if existing and (existing.widget != name or existing.event != event):
        document.execute("Create Handler", lambda project: project.ensure_handler(name, event))
        existing = document.project.code.handlers[handler]
    current = {"kind": "handler", "name": handler}
    if not existing:
        current.update(owner=name, event=event)  # _unsaved_handler: made by the first text typed
    return {"current": current, "body": existing.body if existing else "", "signature": f"def {handler}(e):", "state": doc_state()}


def code_actions(current_widget=None, open_module=None):
    """ActionHelper.rebuild: what can be done with each object, and with the screen."""
    from lvgl_mpy_studio.core.actions import SCREEN_ACTIONS, actions_for, module_actions, page_actions
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.model import page_constant

    project = _doc().project

    def group(title, actions, expanded=False):
        return {"title": title, "expanded": expanded, "actions": [{"label": tr(label), "code": code} for label, code in actions]}

    groups = [group(f"{widget.name} ({widget.type})", actions_for(widget.type, widget.name), widget.name == current_widget) for widget in project.widgets]
    for module in project.modules:
        if module.id == open_module:
            groups.append(group(tr("This module: {name}", name=f"{module.name}.py"), module_actions(module, own=True), True))
        else:
            groups.append(group(tr("Module: {name}", name=f"{module.name}.py"), module_actions(module)))
    groups += [group(tr("Page: {name}", name=page.name), page_actions(page_constant(page.name))) for page in project.pages]
    groups.append(group(tr("Screen"), SCREEN_ACTIONS))
    return groups


def code_entries(qualified):
    """CodePanel._entries and _completions: what completes the dotted name before the cursor, as
    names or [label, text to insert]."""
    from lvgl_mpy_studio.core.actions import method_entries
    from lvgl_mpy_studio.core.components import is_component, methods_for
    from lvgl_mpy_studio.core.model import page_constant

    project = _doc().project
    api = _completion_api()
    parts = qualified.split(".")

    def completions():
        if parts[0] == "lv":
            return [*api["constants"], *api["functions"], *api["objects"]] if len(parts) == 2 else []
        if parts[0] != "ui":
            return []
        if len(parts) == 2:
            pages = [page_constant(page.name) for page in project.pages]
            return [*project.used_names, *pages, "load_page", "load_page_anim", "get_current_page"]
        if len(parts) == 3:
            widget = project.find_widget(parts[1])
            if not widget:
                return []
            if is_component(widget.type):
                return list(methods_for(widget.type))
            object_name = "obj" if widget.type in ("panel", "page") else widget.type
            methods = []
            while object_name in api["objects"]:
                methods.extend(api["objects"][object_name]["methods"])
                object_name = api["objects"][object_name]["parent"]
            return methods
        return []

    if len(parts) == 1:
        needle = qualified.lower()
        return [[name, f"ui.{name}."] for name in sorted(project.used_names) if name.lower().startswith(needle)]
    if parts[0] == "ui" and len(parts) == 3 and project.find_widget(parts[1]):
        widget = project.find_widget(parts[1])
        suggested = method_entries(widget.type, widget.name)
        known = {label.split(" — ")[0] for label, _code in suggested}
        return [list(item) for item in suggested] + sorted(name for name in set(completions()) if name not in known)
    return sorted(set(completions()))


_api_data = None


def _completion_api():
    """CodePanel._api: gen/completion.json."""
    global _api_data
    if _api_data is None:
        from lvgl_mpy_studio.platform import root_dir

        _api_data = json.loads((Path(root_dir()) / "lvgl_mpy_studio" / "gen" / "completion.json").read_text(encoding="utf-8"))
    return _api_data


def module_validate(name, exclude_id=None):
    from lvgl_mpy_studio.core.modules import validate_module_name

    project = _doc().project
    renamed = next((module for module in project.modules if module.id == exclude_id), None)
    return validate_module_name(name, project, exclude=renamed)


def module_references(name):
    from lvgl_mpy_studio.core.modules import module_references as references

    return references(_doc().project, name)


def module_create(name):
    """ui/main_tree.py new_module, after the dialog."""
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.modules import create_module

    _doc().execute(tr("New Module"), lambda project: create_module(project, name, NEW_MODULE_SOURCE))
    module = next(module for module in _doc().project.modules if module.name == name)
    return {"id": module.id, "state": doc_state()}


def module_rename(old, new):
    """ui/main_tree.py rename_module, after the dialog and the question about imports."""
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.modules import rename_module

    warnings = []
    _doc().execute(tr("Rename Module"), lambda project: warnings.extend(rename_module(project, old, new)))
    return {"warnings": warnings, "state": doc_state()}


def module_delete(name):
    """ui/main_tree.py delete_module, after the question."""
    from lvgl_mpy_studio.core.i18n import tr
    from lvgl_mpy_studio.core.modules import delete_module

    warnings = []
    _doc().execute(tr("Delete Module"), lambda project: warnings.extend(delete_module(project, name)))
    return {"warnings": warnings, "state": doc_state()}


METHODS = {
    "info": info,
    "set_language": set_language,
    "generate": generate,
    "export_board": export_board,
    "profiles": profiles,
    "web_runtime_dir": web_runtime_dir,
    "web_prepare": web_prepare,
    "web_build": web_build,
    "program_web": program_web,
    "run_target_plan": run_target_plan,
    "doc_set_run_target": doc_set_run_target,
    "new_project_defaults": new_project_defaults,
    "doc_state": doc_state,
    "doc_new": doc_new,
    "doc_open": doc_open,
    "doc_reload": doc_reload,
    "doc_external_change": doc_external_change,
    "doc_save": doc_save,
    "doc_mark_unsaved": doc_mark_unsaved,
    "doc_undo": doc_undo,
    "doc_redo": doc_redo,
    "doc_rename_page": doc_rename_page,
    "doc_generate": doc_generate,
    "sim_project": sim_project,
    "sim_reset_folder": sim_reset_folder,
    "sim_program": sim_program,
    "syntax_errors": syntax_errors,
    "lv_completions": lv_completions,
    "code_generate_check": code_generate_check,
    "code_compile_errors": code_compile_errors,
    "code_trace_errors": code_trace_errors,
    "code_state": code_state,
    "code_set": code_set,
    "code_objects": code_objects,
    "code_object_of": code_object_of,
    "code_procedures": code_procedures,
    "code_open": code_open,
    "code_actions": code_actions,
    "code_entries": code_entries,
    "module_validate": module_validate,
    "module_references": module_references,
    "module_create": module_create,
    "module_rename": module_rename,
    "module_delete": module_delete,
    "design_page": design_page,
    "fonts_needed": fonts_needed,
    "fonts_put": fonts_put,
    "budget_prepare": budget_prepare,
    "budget_measure": budget_measure,
    "budget_texts": budget_texts,
    "blocks_view": blocks_view,
    "block_source_folder": block_source_folder,
    "block_check": block_check,
    "block_install": block_install,
    "block_install_project": block_install_project,
    "block_remove_question": block_remove_question,
    "block_remove": block_remove,
    "config_dir": config_dir,
    "config_files": config_files,
    "config_reload": config_reload,
    "project_settings_view": project_settings_view,
    "doc_project_settings": doc_project_settings,
    "doc_update_profile": doc_update_profile,
    "profiles_manager": profiles_manager,
    "profile_new": profile_new,
    "profile_check": profile_check,
    "profile_default": profile_default,
    "profiles_hidden": profiles_hidden,
    "profiles_apply": profiles_apply,
    "toolbox": toolbox,
    "design_default_size": design_default_size,
    "design_add_widget": design_add_widget,
    "design_delete": design_delete,
    "design_move": design_move,
    "design_geometry": design_geometry,
    "design_copy": design_copy,
    "design_paste": design_paste,
    "design_duplicate": design_duplicate,
    "design_align": design_align,
    "design_distribute": design_distribute,
    "design_z": design_z,
    "adapt_page_plan": adapt_page_plan,
    "doc_adapt_page": doc_adapt_page,
    "properties_view": properties_view,
    "properties_set": properties_set,
    "asset_upload_path": asset_upload_path,
    "properties_set_asset": properties_set_asset,
    "image_sizes": image_sizes,
    "event_handler": event_handler,
    "design_tree": design_tree,
    "widget_handler": widget_handler,
    "doc_add_page": doc_add_page,
    "doc_delete_page": doc_delete_page,
    "doc_initial_page": doc_initial_page,
    "design_preview": design_preview,
    "resolution_menu": resolution_menu,
    "resolution_plan": resolution_plan,
    "doc_change_resolution": doc_change_resolution,
}


def call(method, arguments_json):
    try:
        arguments = json.loads(arguments_json)
        function = METHODS[method]
        result = function(*arguments) if isinstance(arguments, list) else function(**arguments)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False)
    except Exception as error:  # every failure goes back to the caller, never lost in the worker
        reply = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        if hasattr(error, "deleted"):  # ExternalChangeError: the file was changed or removed from outside
            reply["deleted"] = error.deleted
        return json.dumps({"ok": False, "error": reply}, ensure_ascii=False)
