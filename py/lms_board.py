"""The board, through upstream's DeviceSession, running unchanged in Pyodide.

DeviceSession runs mpremote as a process; here mpremote 1.29.0, the release upstream pins, runs
in-process on the page's serial port (serial/__init__.py). Each call is made by the page with
stack switching (callPromising), so that waiting for the board suspends Python without freezing
the worker: see src/board/.

call(method, arguments_json) -> reply_json, as lms_bridge.call.
"""

import base64
import contextlib
import io
import json
import sys
import threading
import time
import traceback

import serial

_original_sleep = time.sleep


def _sleep(seconds):
    """time.sleep that lets the page's messages in while it waits, inside a board call."""
    from pyodide.ffi import can_run_sync

    if seconds > 0 and can_run_sync():
        import lms_serial

        serial.run(lms_serial.sleep(int(seconds * 1000)))
    else:
        _original_sleep(seconds)


# Before upstream's device modules are imported: their sleep= defaults take time.sleep then.
time.sleep = _sleep

from lvgl_mpy_studio.device.common import DeviceError  # noqa: E402
from lvgl_mpy_studio.device import service  # noqa: E402
from lvgl_mpy_studio.gen import board_gen  # noqa: E402

MPREMOTE_PROG = "mpremote"


def _mpremote(command, timeout):
    """DeviceSession's runner: mpremote's main() on the arguments of its command line.

    What the process would print is collected; an exit code that is not 0 becomes the
    DeviceError that _run_process raises, with the same _port_error."""
    from mpremote import main as mpremote_main

    args = command[command.index(MPREMOTE_PROG) + 1:] if MPREMOTE_PROG in command else command[1:]
    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="replace", write_through=True)
    err = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="replace", write_through=True)
    saved_argv = sys.argv
    sys.argv = [MPREMOTE_PROG, *args]
    serial.set_limits(time.monotonic() + timeout, _state["cancel"])
    aborted = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = mpremote_main.main()
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 0 if exc.code is None else 1
            except serial.Abort as exc:
                aborted, code = exc.code, 1
            except Exception:  # a traceback of mpremote, as the process would print it
                traceback.print_exc()
                code = 1
    finally:
        sys.argv = saved_argv
        serial.set_limits()
    output = out.buffer.getvalue().decode("utf-8", "replace") + err.buffer.getvalue().decode("utf-8", "replace")
    if aborted == "device.cancelled":
        raise DeviceError("device.cancelled")
    if aborted:
        raise DeviceError("device.timeout", output)
    if code:
        raise DeviceError(service._port_error(output), output)
    return output


def _bytecode_file(source, target):
    """board_gen._bytecode_file with mpy-cross in WebAssembly: the same options, the bytes or None."""
    from pathlib import Path

    from pyodide.ffi import to_js

    import lms_serial

    source, target = Path(source), Path(target)
    result = serial.run(lms_serial.mpy_cross(source.name, to_js(source.read_bytes()), to_js(["-s", source.name])))
    if result.code != 0 or result.mpy is None:
        return None
    data = result.mpy.to_bytes()
    target.write_bytes(data)
    return data


# Both names: service imports the function into its own module.
board_gen._bytecode_file = service._bytecode_file = _bytecode_file

_state = {"session": None, "cancel": None}


def _session():
    if _state["session"] is None:
        _state["session"] = service.DeviceSession(runner=_mpremote)
    return _state["session"]


def _profile(profile=None):
    """The profile given, or the open project's board, as MainWindow._board_profile."""
    from lvgl_mpy_studio.core.boards import portable_profile

    if profile is not None:
        return profile
    import lms_bridge

    board = lms_bridge._doc().project.board
    if board is None:
        raise DeviceError("device.profile.required")
    return portable_profile(board)


def project_board():
    """The open project's board profile: its id, name and adapter, or None."""
    try:
        profile = _profile()
    except DeviceError:
        return None
    return {"id": profile["id"], "name": profile.get("name", profile["id"]), "adapter": profile.get("adapter", "")}


def connect(port, profile=None):
    return _session().connect(port, _profile(profile))


def disconnect():
    _session().disconnect()
    return None


def info():
    return _session().info()


def state():
    session = _session()
    return {"port": session.port, "state": session.state, "deviceId": session.device_id, "profile": (session.profile or {}).get("id")}


def list_dir(path):
    return _session().list_dir(path)


def read_file(path):
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="lms-board-read-") as folder:
        local = Path(folder) / "file"
        _session().read_file(path, local)
        return {"data": base64.b64encode(local.read_bytes()).decode("ascii")}


def write_file(path, data):
    return _session().write_file(path, base64.b64decode(data))


def make_dir(path):
    return _session().make_dir(path)


def rename_path(old, new):
    return _session().rename_path(old, new)


def remove_path(path):
    return _session().remove_path(path)


def evaluate(source):
    return _session().evaluate(source, cancel=_state["cancel"])


def _progress(sent, total, name, size):
    import lms_serial

    lms_serial.progress(sent, total, name, size)


def upload(run=False):
    """MainWindow._upload: the open project, generated, compiled and sent; run starts it."""
    import copy

    import lms_bridge
    from lvgl_mpy_studio.gen import live

    project = copy.deepcopy(lms_bridge._doc().project)
    result = _session().upload(project, None, run=run, progress=_progress, cancel=_state["cancel"])
    active = bool(run and result.get("active"))
    current = next((index for index, page in enumerate(project.pages) if page.id == project.currentPageId), 0)
    return {
        "appPath": result.get("appPath"),
        "files": result.get("files", []),
        "warnings": result.get("warnings", []),
        "sourcemap": result.get("sourcemap"),
        "output": result.get("output", ""),
        "active": active,
        "uploadKey": live.upload_key(project) if active else None,
        "designKey": live.design_key(project, current) if active else None,
    }


def stop():
    return _session().stop()


def restart():
    return _session().restart()


def leave_raw():
    """Before the console takes the port: the normal prompt, as start_console(interactive=True)."""
    session = _session()
    if session._uart is not None:
        session._uart.leave_raw()
    return None


METHODS = {
    "project_board": project_board,
    "connect": connect,
    "disconnect": disconnect,
    "info": info,
    "state": state,
    "list_dir": list_dir,
    "read_file": read_file,
    "write_file": write_file,
    "make_dir": make_dir,
    "rename_path": rename_path,
    "remove_path": remove_path,
    "evaluate": evaluate,
    "upload": upload,
    "stop": stop,
    "restart": restart,
    "leave_raw": leave_raw,
}


def _error(error):
    reply = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    if isinstance(error, DeviceError):
        from lvgl_mpy_studio.core.i18n import device_error_text

        reply.update(code=error.code, output=error.output, errors=error.errors, warnings=error.warnings, text=device_error_text(error.code, error.output))
    return reply


def call(method, arguments_json):
    """One operation on the board, called with stack switching; one at a time (the page queues)."""
    _state["cancel"] = threading.Event()
    try:
        arguments = json.loads(arguments_json)
        function = METHODS[method]
        result = function(*arguments) if isinstance(arguments, list) else function(**arguments)
        return json.dumps({"ok": True, "result": result}, ensure_ascii=False)
    except Exception as error:  # every failure goes back to the page, never lost in the worker
        return json.dumps({"ok": False, "error": _error(error)}, ensure_ascii=False)
    finally:
        _state["cancel"] = None


def cancel():
    """Called without stack switching while a board call waits: it stops after the current command."""
    if _state["cancel"] is not None:
        _state["cancel"].set()
    return json.dumps({"ok": True, "result": None})
