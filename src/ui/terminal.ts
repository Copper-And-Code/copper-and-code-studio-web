// xterm.js for the terminal of a program and for the Device Console, loaded when the first
// terminal is made and not with the IDE's first script, of which it was a third: the shell shows
// and Python starts without waiting for it. What is written to a terminal before it is there is
// kept by its component and written when it opens.
import type { FitAddon } from '@xterm/addon-fit';
import type { ITerminalOptions, Terminal } from '@xterm/xterm';

export interface OpenTerminal {
  terminal: Terminal;
  fit: FitAddon;
}

type Modules = [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')];
let loading: Promise<Modules> | null = null;

export async function openTerminal(
  host: HTMLElement,
  options: ITerminalOptions,
): Promise<OpenTerminal> {
  if (!loading) {
    const started = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    // a load that failed (the network) is tried again by the next terminal
    started.catch(() => {
      if (loading === started) loading = null;
    });
    loading = started;
  }
  const [xterm, addon] = await loading;
  const terminal = new xterm.Terminal(options);
  const fit = new addon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  return { terminal, fit };
}
