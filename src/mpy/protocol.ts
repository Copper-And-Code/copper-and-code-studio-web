export interface CompileRequest {
  id: number;
  /** The file name, as mpy-cross is given it: errors name it. */
  name: string;
  source: Uint8Array;
  /** Options before the file name, e.g. -march. */
  args: string[];
}

export interface CompileReply {
  id: number;
  /** false: mpy-cross could not be loaded or crashed; output says why. */
  ok: boolean;
  /** mpy-cross's exit code: 0 when the file compiled. */
  code: number;
  /** What mpy-cross printed: the errors, in upstream's format. */
  output: string;
  mpy: Uint8Array | null;
}
