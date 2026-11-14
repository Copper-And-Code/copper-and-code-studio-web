import type { PyodideInterface } from 'pyodide';
export const ROOT: string;
export function startPyodide(): Promise<PyodideInterface>;
export function copyIn(
  py: PyodideInterface,
  source: string,
  target: string,
  skip?: Set<string>,
): void;
