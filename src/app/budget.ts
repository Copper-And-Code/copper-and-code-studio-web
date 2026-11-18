// The budget in the status bar, as upstream's ui/budget.py BudgetMonitor: after a pause in the
// changes, the project's flash size and the RAM it uses, measured by build/budget.py's
// measure_budget. Its two processes are done here: mpy-cross in WebAssembly compiles the files
// first, and the instrumented app runs in a hidden simulator after.
import type { MpyCross } from '../mpy/mpy-cross.ts';
import type { PythonBridge } from '../py/bridge.ts';
import { type SimFile, type SimState, Simulator } from '../sim/simulator.ts';

const DELAY_MS = 1500; // ui/budget.py DELAY_MS
const RUN_TIMEOUT_MS = 5000; // build/budget.py RUN_TIMEOUT

export interface Budget {
  flash: number;
  ram: number | null;
}

export interface Limits {
  ram?: number;
  flash?: number;
  mpy?: number;
}

export interface BudgetText {
  text: string;
  level: 0 | 1 | 2;
  tooltip: string;
}

interface Job {
  path: string;
  name: string;
  args: string[];
  key: string;
}

export class BudgetMonitor {
  budget: Budget | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private dirty = false;
  private limits: Limits = {};
  private simulator: Simulator | null = null;
  private settle: ((value: string) => void) | null = null;
  private log = '';
  private readonly listeners = new Set<(budget: Budget | null) => void>();
  /** What mpy-cross gave for a file, by the key of its text and arguments. */
  private readonly compiled = new Map<string, { mpy?: Uint8Array; output?: string }>();
  /** True while the simulator runs a program: the measure waits, not to slow it down. */
  paused: () => boolean = () => false;

  constructor(
    private readonly python: PythonBridge,
    private readonly mpyCross: MpyCross,
    private readonly host: HTMLElement,
  ) {}

  onUpdate(listener: (budget: Budget | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** BudgetMonitor.schedule: measured again after DELAY_MS without changes. */
  schedule(limits: Limits): void {
    this.limits = limits;
    clearTimeout(this.timer);
    this.waiting = true;
    this.timer = setTimeout(() => {
      this.waiting = false;
      void this.start();
    }, DELAY_MS);
  }

  private waiting = false;

  /** Nothing measured now or about to be: for lmsCapture.idle(). */
  get idle(): boolean {
    return !this.running && !this.waiting;
  }

  stop(): void {
    clearTimeout(this.timer);
    this.waiting = false;
    this.dirty = false;
  }

  /** budget_text, budget_level and the tooltip, in upstream's words. */
  text(): Promise<BudgetText> {
    return this.python.call<BudgetText>('budget_texts', this.budget, this.limits);
  }

  private async start(): Promise<void> {
    if (this.paused()) {
      this.schedule(this.limits);
      return;
    }
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    let result: Budget | null;
    try {
      result = await this.measure(this.limits.mpy ?? null);
    } catch {
      result = null;
    }
    this.budget = result;
    for (const listener of this.listeners) listener(result);
    this.running = false;
    if (this.dirty) {
      this.dirty = false;
      this.schedule(this.limits);
    }
  }

  /** measure_budget: compile, sum the flash, run for the RAM. */
  private async measure(boardMpy: number | null): Promise<Budget | null> {
    const prepared = await this.python.call<{ jobs: Job[]; cache: string }>(
      'budget_prepare',
      boardMpy,
    );
    const used = new Set<string>();
    for (const job of prepared.jobs) {
      used.add(job.key);
      // a file compiled before, with the same text and arguments, is not compiled again
      let compiled = this.compiled.get(job.key);
      if (!compiled) {
        const data = await this.python.readFile(job.path);
        if (!data) continue;
        const result = await this.mpyCross.compile(job.name, data, job.args);
        compiled =
          result.code === 0 && result.mpy ? { mpy: result.mpy } : { output: result.output };
        this.compiled.set(job.key, compiled);
      }
      if (compiled.mpy) {
        await this.python.writeFile(`${prepared.cache}/${job.key}.mpy`, compiled.mpy);
      } else {
        await this.python.writeFile(
          `${prepared.cache}/${job.key}.out`,
          new TextEncoder().encode(compiled.output ?? ''),
        );
      }
    }
    for (const key of [...this.compiled.keys()]) if (!used.has(key)) this.compiled.delete(key);
    const measured = await this.python.call<{
      flash: number;
      run: { directory: string; files: string[]; width: number; height: number } | null;
      marker: string;
    } | null>('budget_measure', boardMpy);
    if (!measured) return null;
    let ram: number | null = null;
    if (measured.run) ram = await this.runRam(measured.run, measured.marker);
    return { flash: measured.flash, ram };
  }

  /** _measure_ram: the instrumented app prints the RAM it holds after the first loops. */
  private async runRam(
    run: { directory: string; files: string[]; width: number; height: number },
    marker: string,
  ): Promise<number | null> {
    const files: SimFile[] = [];
    for (const name of run.files) {
      const data = await this.python.readFile(`${run.directory}/${name}`);
      if (data) files.push([name, data]);
    }
    this.simulator ??= new Simulator(this.host, {
      output: (text) => {
        this.log += text;
        if (this.log.includes(marker)) this.settle?.(this.log);
      },
      state: (state: SimState) => {
        if (state === 'ended' || state === 'failed') this.settle?.(this.log);
      },
    });
    this.log = '';
    const done = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(this.log), RUN_TIMEOUT_MS);
      this.settle = (log) => {
        clearTimeout(timer);
        resolve(log);
      };
    });
    await this.simulator.start({
      mode: 'project',
      width: run.width,
      height: run.height,
      board: 'simulator',
      entry: 'main.py',
      system: [],
      files,
    });
    const log = await done;
    this.settle = null;
    await this.simulator.stop();
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped} (-?\\d+)`).exec(log);
    return match?.[1] ? Math.max(0, Number(match[1])) : null;
  }

  dispose(): void {
    this.stop();
    this.simulator?.dispose();
  }
}
