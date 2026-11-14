// The designer's calls into upstream: what a page puts on the canvas (ui/designer/scene.py
// rebuild), the page generated design-only for the preview (build/preview.py), and the
// resolution (ui/main_resolution.py), with its undo step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DesignPage, DesignTree, ResolutionMenu } from '../../src/app/designer.ts';
import type { PythonBridge } from '../../src/py/bridge.ts';
import type { DocState } from '../../src/project/session.ts';
import { inProcessBridge } from './in-process.ts';
import { ROOT } from './pyodide-node.mjs';

const example = (name: string) =>
  readFileSync(join(ROOT, `upstream/examples/${name}/project.json`));

describe('designer', () => {
  let python: PythonBridge;
  let state: DocState;

  async function open(name: string): Promise<DocState> {
    await python.writeFile(`/ws/test/${name}.json`, new Uint8Array(example(name)));
    state = await python.call<DocState>('doc_open', `/ws/test/${name}.json`);
    return state;
  }

  beforeEach(async () => {
    python ??= await inProcessBridge();
    await open('eim-01');
  });

  it('lists the widgets of a page as rebuild places them: containers first, no components', async () => {
    for (const { id } of state.pages) {
      const page = await python.call<DesignPage>('design_page', id);
      const seen = new Set<string>();
      for (const widget of page.widgets) {
        if (widget.parentId) expect(seen.has(widget.parentId), widget.name).toBe(true);
        expect(['timer', 'buzzer']).not.toContain(widget.type);
        seen.add(widget.id);
      }
      expect(page.widgets.length).toBeGreaterThan(0);
      expect(page.display).toEqual(state.display);
    }
  });

  it('changes the design key when the page changes, not when the code does', async () => {
    const id = state.pages[0]?.id ?? '';
    const before = await python.call<DesignPage>('design_page', id);
    await python.call('code_set', 'module', 'module', '# only code\n', 1);
    expect((await python.call<DesignPage>('design_page', id)).key).toBe(before.key);
    await python.call('doc_change_resolution', 480, 480, 'stretch');
    expect((await python.call<DesignPage>('design_page', id)).key).not.toBe(before.key);
  });

  it('generates the page design-only: the code of the project is left out', async () => {
    const id = state.pages[1]?.id ?? '';
    await python.call('code_set', 'module', 'module', 'MARKER_FROM_CODE = 1\n', 1);
    const preview = await python.call<{ directory: string; files: string[]; width: number }>(
      'design_preview',
      id,
      null,
    );
    expect(preview.width).toBe(state.display.width);
    for (const name of preview.files) {
      const data = await python.readFile(`${preview.directory}/${name}`);
      expect(new TextDecoder().decode(data ?? new Uint8Array()), name).not.toContain(
        'MARKER_FROM_CODE',
      );
    }
    // a drag not recorded yet moves the widget in the preview only
    const page = await python.call<DesignPage>('design_page', id);
    const widget = page.widgets[0];
    if (!widget) throw new Error('no widget');
    const moved = await python.call<{ key: string }>('design_preview', id, {
      [widget.id]: { x: 3, y: 4, width: 50, height: 60 },
    });
    expect(moved.key).not.toBe(page.key);
    expect((await python.call<DesignPage>('design_page', id)).key).toBe(page.key);
  });

  it('changes the resolution in one undo step and lists the widgets left outside', async () => {
    const menu = await python.call<ResolutionMenu>('resolution_menu');
    expect(menu.common.map((size) => `${size.width}×${size.height}`)).toEqual([
      '240×240',
      '480×480',
      '1024×600',
      '1024×1024',
    ]);
    expect(menu.boards.length).toBeGreaterThan(0);
    expect(menu.current).toEqual(state.display);

    expect(await python.call('resolution_plan', 1024, 600)).toEqual({ same: true, note: '' });
    const plan = await python.call<{ same: boolean; note: string }>('resolution_plan', 480, 480);
    expect(plan.note).toContain('it will be unlinked and the simulator selected');

    const result = await python.call<{ outside: string[]; state: DocState }>(
      'doc_change_resolution',
      480,
      480,
      'keep',
    );
    expect(result.state.display).toEqual({ width: 480, height: 480 });
    expect(result.state.board).toBeNull();
    expect(result.state.undoText).toBe('Change Resolution');
    expect(result.outside.length).toBeGreaterThan(0); // kept where they were, on a smaller page
    const page = await python.call<DesignPage>('design_page', state.pages[0]?.id ?? '');
    expect(page.designSize).toEqual([1024, 600]);

    const undone = await python.call<DocState>('doc_undo');
    expect(undone.display).toEqual({ width: 1024, height: 600 });
    expect(undone.board).not.toBeNull();
  });

  it('builds the project tree and the components strip as ui/main_tree.py', async () => {
    await open('fifteen');
    const tree = await python.call<DesignTree>('design_tree');
    expect(tree.pages.map((page) => page.name)).toEqual(['Menu', 'Game', 'Options', 'Solved']);
    expect(tree.pages[0]?.widgets.slice(0, 3)).toEqual([
      { name: 'beeper', type: 'buzzer', component: true },
      { name: 'tick', type: 'timer', component: true },
      { name: 'menu_bg', type: 'panel', component: false },
    ]);
    expect(tree.components).toEqual([
      { name: 'beeper', type: 'buzzer', events: false },
      { name: 'tick', type: 'timer', events: true },
    ]);
    expect(await python.call('widget_handler', 'btn_play')).toBe('btn_play_clicked');
    expect(await python.call('widget_handler', 'tick')).toBe('tick_tick');
    expect(await python.call('widget_handler', 'menu_bg')).toBeNull();
  });

  it('adds, moves first and deletes pages, each an undo step; the last page stays', async () => {
    await open('weather');
    let doc = await python.call<DocState>('doc_add_page');
    expect(doc.pages.map((page) => page.name)).toEqual(['main', 'settings', 'page3']);
    expect(doc.undoText).toBe('Add Page');
    const added = doc.pages[2]?.id ?? '';
    doc = await python.call<DocState>('doc_initial_page', added);
    expect(doc.pages[0]?.name).toBe('page3');
    expect(doc.undoText).toBe('Initial Page');
    for (const page of doc.pages.slice(1)) {
      const result = await python.call<{ error: string | null; state: DocState }>(
        'doc_delete_page',
        page.id,
      );
      expect(result.error).toBeNull();
      expect(result.state.undoText).toBe('Delete Page');
    }
    const last = await python.call<{ error: string | null; state: DocState }>(
      'doc_delete_page',
      added,
    );
    expect(last.error).toBe('The last page cannot be deleted');
    expect(last.state.pages).toHaveLength(1);
  });
});
