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


METHODS = {"info": info, "generate": generate, "export_board": export_board}


def call(method, arguments_json):
    try:
        arguments = json.loads(arguments_json)
        function = METHODS[method]
        result = function(*arguments) if isinstance(arguments, list) else function(**arguments)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False)
    except Exception as error:  # every failure goes back to the caller, never lost in the worker
        return json.dumps({"ok": False, "error": {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}}, ensure_ascii=False)
