// The project's Code tab, as upstream's ui/code/editor.py CodePanel and the module actions of
// ui/main_tree.py: the general code, the handlers and the Python modules in one editor; each edit
// is a step of the project's undo, merged while the same thing stays open; the syntax check
// compiles the generated project with mpy-cross and keeps the errors of what is open.
import { tr } from '../i18n/tr.ts';
import type { MpyCross } from '../mpy/mpy-cross.ts';
import type { PythonBridge } from '../py/bridge.ts';
import type { DocState, ProjectSession } from '../project/session.ts';
import type { Dialogs } from '../ui/dialogs.ts';

export interface CodeState {
  module: string;
  handlers: { name: string; widget: string; event: string; body: string }[];
  modules: { id: string; name: string; source: string }[];
}

/** What is open: the general code, a handler by name, a module by id (the name changes). */
export type CodeKey =
  { kind: 'module' } | { kind: 'handler'; name: string } | { kind: 'pymodule'; id: string };

export interface MappedError {
  file?: string | null;
  line: number;
  message: string;
  module?: string;
  handler?: string;
  sourceLine?: number;
  origin?: boolean;
  tooltip?: string;
}

const CHECK_DELAY_MS = 500; // CodePanel.check_timer

export const keyId = (key: CodeKey) =>
  key.kind === 'module'
    ? 'module'
    : key.kind === 'handler'
      ? `handler:${key.name}`
      : `pymodule:${key.id}`;

export function parseKey(id: string): CodeKey {
  if (id.startsWith('handler:')) return { kind: 'handler', name: id.slice(8) };
  if (id.startsWith('pymodule:')) return { kind: 'pymodule', id: id.slice(9) };
  return { kind: 'module' };
}

export class CodeController {
  state: CodeState = { module: '', handlers: [], modules: [] };
  current: CodeKey = { kind: 'module' };
  /** Errors of the whole project at the last check; errors() keeps those of what is open. */
  allErrors: MappedError[] = [];
  private session = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /** Set while an edit goes to Python, so that the reply does not rewrite the editor. */
  private editing = Promise.resolve();
  private checking = 0;
  private compiling: Promise<void> = Promise.resolve();
  /** True while the project changes because of this tab: no need to read the code back. */
  adopting = false;
  /** The Code tab is shown: only then a change of the project starts a check. */
  private active = false;

  constructor(
    private readonly python: PythonBridge,
    private readonly project: ProjectSession,
    private readonly dialogs: Dialogs,
    private readonly mpyCross: MpyCross,
    private readonly output: (text: string) => void,
    private readonly status: (message: string) => void,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** After a new, opened or reloaded project, or undo and redo: the code as Python has it. */
  async refresh(): Promise<void> {
    await this.editing;
    this.state = await this.python.call<CodeState>('code_state');
    if (!this.exists(this.current)) this.current = { kind: 'module' };
    this.changed();
    if (this.active) this.scheduleCheck();
  }

  /** The Code tab shown or hidden: a check when it comes to the front, as the desktop's panel. */
  setActive(active: boolean): void {
    if (active && !this.active) this.scheduleCheck(0);
    this.active = active;
  }

  private exists(key: CodeKey): boolean {
    if (key.kind === 'handler') return this.state.handlers.some((h) => h.name === key.name);
    if (key.kind === 'pymodule') return this.state.modules.some((m) => m.id === key.id);
    return true;
  }

  text(key: CodeKey = this.current): string {
    if (key.kind === 'handler')
      return this.state.handlers.find((h) => h.name === key.name)?.body ?? '';
    if (key.kind === 'pymodule')
      return this.state.modules.find((m) => m.id === key.id)?.source ?? '';
    return this.state.module;
  }

  moduleName(key: CodeKey = this.current): string | null {
    return key.kind === 'pymodule'
      ? (this.state.modules.find((m) => m.id === key.id)?.name ?? null)
      : null;
  }

  /** Opens something else: a new editing session, so the next edit is a new undo step. */
  select(key: CodeKey): void {
    this.current = key;
    this.session++;
    this.changed();
    this.scheduleCheck(0);
  }

  openModule(name: string): boolean {
    const module = this.state.modules.find((m) => m.name === name);
    if (!module) return false;
    this.select({ kind: 'pymodule', id: module.id });
    return true;
  }

  openHandler(name: string): boolean {
    if (!this.state.handlers.some((h) => h.name === name)) return false;
    this.select({ kind: 'handler', name });
    return true;
  }

  /** CodePanel._text_changed: the text into the project, one undo step per session. */
  edit(text: string): void {
    const key = this.current;
    if (text === this.text(key)) return;
    if (key.kind === 'handler') {
      const handler = this.state.handlers.find((h) => h.name === key.name);
      if (handler) handler.body = text;
    } else if (key.kind === 'pymodule') {
      const module = this.state.modules.find((m) => m.id === key.id);
      if (module) module.source = text;
    } else {
      this.state.module = text;
    }
    const id = key.kind === 'handler' ? key.name : key.kind === 'pymodule' ? key.id : 'module';
    const session = this.session;
    this.editing = this.editing.then(async () => {
      const state = await this.python.call<DocState>('code_set', key.kind, id, text, session);
      this.adoptState(state);
    });
    this.scheduleCheck();
  }

  private adoptState(state: DocState): void {
    this.adopting = true;
    try {
      this.project.adopt(state);
    } finally {
      this.adopting = false;
    }
  }

  private scheduleCheck(delay = CHECK_DELAY_MS): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), delay);
  }

  /** CodePanel.check_syntax: the project generated and compiled; the errors of what is open. */
  async check(): Promise<MappedError[]> {
    const ticket = ++this.checking;
    await this.editing;
    let errors: MappedError[];
    try {
      errors = await this.compileProject();
    } catch {
      return []; // no mpy-cross: no opinion
    }
    if (ticket !== this.checking) return errors;
    this.allErrors = errors;
    this.changed();
    return errors;
  }

  /**
   * compile_python with mpy-cross in WebAssembly, then upstream's map_error, on the project with
   * every edit already in Python. One at a time: the check and Start generate into the same
   * folder, and a file read while the other call writes it would be half a file.
   */
  compileProject(): Promise<MappedError[]> {
    const result = this.compiling.then(async () => {
      await this.editing; // what was typed last, not the text of a moment ago
      const generated = await this.python.call<{ directory: string; files: string[] }>(
        'code_generate_check',
      );
      return this.compileDirectory(generated.directory, generated.files);
    });
    this.compiling = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** compile_python on files of a folder of Pyodide's file system, with upstream's map_error. */
  async compileDirectory(directory: string, files: string[]): Promise<MappedError[]> {
    const outputs: Record<string, string> = {};
    for (const name of files) {
      const data = await this.python.readFile(`${directory}/${name}`);
      if (!data) continue;
      const result = await this.mpyCross.compile(name, data);
      if (result.code !== 0) outputs[name] = result.output;
    }
    if (!Object.keys(outputs).length) return [];
    return this.python.call<MappedError[]>('code_compile_errors', directory, outputs);
  }

  /** The errors that belong to what is open, as check_syntax filters them. */
  errors(): MappedError[] {
    const key = this.current;
    const module = this.moduleName(key);
    return this.allErrors.filter((error) =>
      module !== null
        ? error.module === module
        : error.handler ===
          (key.kind === 'module' ? 'module' : key.kind === 'handler' ? key.name : ''),
    );
  }

  // ---- modules: ui/main_tree.py ----

  /** _ask_module_name: asks until the name is valid or the user cancels. */
  private async askModuleName(
    title: string,
    current = '',
    excludeId?: string,
  ): Promise<string | null> {
    let text = current;
    for (;;) {
      const answer = await this.dialogs.askText(title, tr('Module name, without .py:'), text);
      const name = (answer ?? '').trim().replace(/\.py$/, '');
      if (answer === null || !name || (current && name === current)) return null;
      const error = await this.python.call<string | null>(
        'module_validate',
        name,
        excludeId ?? null,
      );
      if (error === null) return name;
      const message = tr('Invalid module name: {error}', { error });
      this.output(`${message}\n`);
      await this.dialogs.notice(title, message);
      text = name;
    }
  }

  private showWarnings(warnings: string[]): void {
    for (const warning of warnings) this.output(`${tr('Warning: {warning}', { warning })}\n`);
    if (warnings.length) {
      this.status(
        tr('Code still imports a module that no longer has that name: see Output ({count})', {
          count: warnings.length,
        }),
      );
    }
  }

  async newModule(): Promise<boolean> {
    const name = await this.askModuleName(tr('New Python Module'));
    if (name === null) return false;
    await this.editing;
    const created = await this.python.call<{ id: string; state: DocState }>('module_create', name);
    this.adoptState(created.state);
    await this.refresh();
    this.select({ kind: 'pymodule', id: created.id });
    return true;
  }

  async renameModule(): Promise<boolean> {
    const old = this.moduleName();
    if (old === null) return false;
    const id = this.current.kind === 'pymodule' ? this.current.id : undefined;
    const name = await this.askModuleName(tr('Rename Module'), old, id);
    if (name === null) return false;
    const references = await this.python.call<string[]>('module_references', old);
    if (references.length) {
      const yes = await this.dialogs.message(
        tr('Rename Module'),
        tr(
          'Code still imports {old}: after renaming it to {new}, those imports will stop with ImportError until you update them by hand.',
          { old, new: name },
        ),
        [
          { label: tr('Yes'), value: true },
          { label: tr('No'), value: false, primary: true },
        ],
        false,
        references.join('\n'),
      );
      if (!yes) return false;
    }
    await this.editing;
    const result = await this.python.call<{ warnings: string[]; state: DocState }>(
      'module_rename',
      old,
      name,
    );
    this.adoptState(result.state);
    this.showWarnings(result.warnings);
    await this.refresh();
    return true;
  }

  async deleteModule(): Promise<boolean> {
    const name = this.moduleName();
    if (name === null) return false;
    const references = await this.python.call<string[]>('module_references', name);
    let question = tr('Delete the module {name}.py? Undo can bring it back.', { name });
    if (references.length) {
      question += `\n\n${tr('Code still imports it: until you update it, the app will stop with ImportError when it reaches that import.')}`;
    }
    const yes = await this.dialogs.message(
      tr('Delete Module'),
      question,
      [
        { label: tr('Yes'), value: true },
        { label: tr('No'), value: false, primary: true },
      ],
      false,
      references.length ? references.join('\n') : undefined,
    );
    if (!yes) return false;
    await this.editing;
    const result = await this.python.call<{ warnings: string[]; state: DocState }>(
      'module_delete',
      name,
    );
    this.adoptState(result.state);
    this.showWarnings(result.warnings);
    this.current = { kind: 'module' };
    await this.refresh();
    return true;
  }
}
