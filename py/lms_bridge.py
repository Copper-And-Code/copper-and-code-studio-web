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
        "canUndo": stack.can_undo(),
        "canRedo": stack.can_redo(),
        "undoText": stack.undo_text(),
        "redoText": stack.redo_text(),
    }


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


def code_set(kind, key, text, session=0):
    """ui/code/editor.py _text_changed: one undo step per editing session (merge id 10000 + session)."""
    from lvgl_mpy_studio.core.modules import set_module_source

    document = _doc()
    project = document.project
    if kind == "module":
        mutator = lambda project: setattr(project.code, "module", text)  # noqa: E731
    elif kind == "pymodule":
        name = next(module.name for module in project.modules if module.id == key)
        mutator = lambda project: set_module_source(project, name, text)  # noqa: E731
    else:
        mutator = lambda project: setattr(project.code.handlers[key], "body", text)  # noqa: E731
    document.execute("Edit Code", mutator, 10000 + int(session), True)
    return doc_state()


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
    "generate": generate,
    "export_board": export_board,
    "profiles": profiles,
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
    "module_validate": module_validate,
    "module_references": module_references,
    "module_create": module_create,
    "module_rename": module_rename,
    "module_delete": module_delete,
    "design_page": design_page,
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
