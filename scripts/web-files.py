"""The files of the web version of each example, as upstream's build/web.py writes them on the host:
build_web for a project with pages, build_program_web for the shell. The web IDE must build the
same file list (tests/py/web.test.ts, tests/e2e/web.spec.ts).

build_web needs the native mpy-cross and the web runtime, which upstream's submodule does not
carry: pass those of a desktop checkout.

Usage: LMS_MPY_CROSS=<desktop>/runtime/out/mpy-cross LMS_WEB_RUNTIME=<desktop>/runtime/out-web \\
       python3 -I scripts/web-files.py [out]   (default: tests/fixtures/web/files.json)
"""

import json
import os
import sys
import tempfile
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from lvgl_mpy_studio.build import compiler, web  # noqa: E402
from lvgl_mpy_studio.core.model import Project  # noqa: E402

PROGRAMS = {"shell": "shell.py"}


def files_under(folder):
    return [path.relative_to(folder).as_posix() for path in sorted(folder.rglob("*")) if path.is_file()]


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "fixtures" / "web" / "files.json"
    web.compile_python = partial(compiler.compile_python, mpy_cross=os.environ["LMS_MPY_CROSS"])
    runtime = Path(os.environ["LMS_WEB_RUNTIME"])
    web.web_runtime = lambda: runtime
    result = {}
    examples = UPSTREAM / "examples"
    with tempfile.TemporaryDirectory(prefix="lms-web-files-") as temporary:
        for folder in sorted(path for path in examples.iterdir() if (path / "project.json").is_file()):
            project = Project.load(folder / "project.json")
            target = web.build_web(project, Path(temporary) / folder.name)
            result[folder.name] = {"folder": target.name, "files": files_under(target)}
        for name, entry in PROGRAMS.items():
            target = web.build_program_web(examples / name / entry, Path(temporary) / f"program-{name}")
            result[f"program:{name}"] = {"folder": target.name, "files": files_under(target)}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"{out}: {len(result)} web versions")


if __name__ == "__main__":
    main()
