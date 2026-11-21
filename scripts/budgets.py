"""Budget references: upstream's build/budget.py measure_budget on the host, for each example.

The flash is the size of the files that would go on the board, compiled by the native mpy-cross:
the web IDE compiles the same files with mpy-cross in WebAssembly, which gives the same bytes
(tests/py/mpy-cross.test.ts), so the flash must be the same number. For a project without a
compatible board, upstream's compile_python gives mpy-cross the absolute path of each file, which
goes into the .mpy: its number depends on where the temporary folder is (upstream request 8). So
flashByName is measured too, with compile_python giving the file's name, as the web IDE does;
that is the number the web IDE must show. The RAM is measured by the
native runtime, 64-bit: the web IDE measures it in the 32-bit WebAssembly runtime, so it is
written here for comparison only.

The native runtime and mpy-cross are not built in the submodule: pass the folder of a desktop
checkout's runtime/out, built with upstream's runtime/build.sh at the same tag.

Usage: python3 -I scripts/budgets.py <runtime/out folder> [out]   (default: tests/fixtures/budget)
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "upstream"
sys.path.insert(0, str(UPSTREAM))

from copper_and_code_studio import __version__  # noqa: E402
from copper_and_code_studio.build import budget, compiler  # noqa: E402
from copper_and_code_studio.core.model import Project  # noqa: E402
from copper_and_code_studio.gen import board_gen  # noqa: E402


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    out_dir = Path(argv[1]).resolve()
    mpy_cross = out_dir / "mpy-cross"
    compiler.default_mpy_cross = board_gen.default_mpy_cross = lambda: mpy_cross
    budget.runtime_path = lambda: out_dir / "lvsim-runtime"
    out = Path(argv[2]) if len(argv) > 2 else ROOT / "tests" / "fixtures" / "budget"
    out.mkdir(parents=True, exist_ok=True)
    index = {"upstreamVersion": __version__, "budgets": {}}
    upstream_compile = budget.compile_python

    def by_name(directory, mpy_cross=None):
        """compile_python, with each file given to mpy-cross by its name, from its folder."""
        directory = Path(directory).resolve()
        errors = []
        for path in sorted(directory.glob("*.py")):
            result = subprocess.run([str(mpy_cross_path), path.name], capture_output=True, text=True, cwd=directory)
            if result.returncode:
                errors.extend(compiler.parse_compiler_errors(result.stderr + result.stdout, directory))
        if errors:
            raise compiler.CompileError(errors)
        return True

    mpy_cross_path = mpy_cross
    for path in sorted((UPSTREAM / "examples").glob("*/project.json")):
        budget.compile_python = upstream_compile
        result = budget.measure_budget(Project.load(path))
        budget.compile_python = by_name
        named = budget.measure_budget(Project.load(path))
        result["flashByName"] = named["flash"] if named else None
        index["budgets"][path.parent.name] = result
        print(path.parent.name, result)
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
