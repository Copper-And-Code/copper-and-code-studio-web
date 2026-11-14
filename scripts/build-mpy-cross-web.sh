#!/usr/bin/env bash
# mpy-cross in WebAssembly: the recipe proposed to upstream as runtime/build_mpy_cross_web.sh
# (docs/upstream-requests.md, request 2). It builds outside the MicroPython checkout, which it only
# reads, and writes mpy-cross.mjs and mpy-cross.wasm into the output folder.
#
#   scripts/build-mpy-cross-web.sh <micropython checkout> <emsdk folder> <output folder>
#
# MicroPython's garbage collector finds its roots by scanning the C stack and the registers; in
# WebAssembly the locals are out of its reach, so a collection could free live objects. The
# collector runs only when the heap is full: the page runs a fresh instance for each compilation
# with a heap far larger than one source file needs (-X heapsize=64M, the native default is 2 MB),
# so no collection ever runs. The build itself is mpy-cross as it is.
set -euo pipefail
MICROPYTHON=$(cd "$1" && pwd)
EMSDK=$(cd "$2" && pwd)
OUT=$(mkdir -p "$3" && cd "$3" && pwd)
JOBS=${JOBS:-4}
# shellcheck disable=SC1091
. "$EMSDK/emsdk_env.sh" > /dev/null
BUILD="$OUT/build"
rm -f "$BUILD/mpy-cross.mjs" "$BUILD/mpy-cross.wasm"  # the link flags are not a dependency of the link
make -C "$MICROPYTHON/mpy-cross" -j"$JOBS" \
    BUILD="$BUILD" \
    PROG=mpy-cross.mjs \
    CC=emcc \
    LDFLAGS_ARCH= \
    CWARN="-Wall -Wno-unused-parameter" \
    STRIP=true \
    SIZE=true \
    LDFLAGS_EXTRA="-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMpyCross \
-sENVIRONMENT=web,worker,node -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1 \
-sEXPORTED_RUNTIME_METHODS=callMain,FS -sFORCE_FILESYSTEM=1 -O2 \
-sINCOMING_MODULE_JS_API=wasmBinary,instantiateWasm,locateFile,print,printErr"
cp "$BUILD/mpy-cross.mjs" "$BUILD/mpy-cross.wasm" "$OUT/"
ls -la "$OUT/mpy-cross.mjs" "$OUT/mpy-cross.wasm"
