"""The calls the web IDE makes into upstream, running in Pyodide.

Thin glue only: every function hands its work to upstream's own code, unchanged, and turns the
result into JSON for the TypeScript side. No upstream logic is reimplemented here.

call(method, arguments_json) -> reply_json is the single entry point. A reply is
{"ok": true, "result": ...} or {"ok": false, "error": {"type": ..., "message": ...}}.
"""

import json
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
