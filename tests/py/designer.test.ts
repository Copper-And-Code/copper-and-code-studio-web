// The designer's calls into upstream: what a page puts on the canvas (ui/designer/scene.py
// rebuild), the page generated design-only for the preview (build/preview.py), and the
// resolution (ui/main_resolution.py), with its undo step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DesignPage,
  DesignTree,
  PropertiesView,
  ResolutionMenu,
} from '../../src/app/designer.ts';
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

  it('shows the properties as ui/properties/panel.py: common ones, categories, events', async () => {
    await open('fifteen');
    const one = await python.call<PropertiesView>('properties_view', ['btn_play']);
    expect(one.categories.map((category) => category.name)).toEqual([
      'Identity',
      'Position',
      'Appearance',
    ]);
    expect(one.categories[0]?.rows[0]).toMatchObject({ name: 'Name', value: 'btn_play' });
    expect(one.categories[1]?.rows.map((row) => row.name)).toEqual(['x', 'y', 'width', 'height']);
    expect(one.events.find((event) => event.event === 'CLICKED')).toMatchObject({
      handler: 'btn_play_clicked',
      bound: true,
    });
    // a label and a button share their geometry and text; different values are shown empty
    const two = await python.call<PropertiesView>('properties_view', ['btn_play', 'menu_title']);
    const rows = two.categories.flatMap((category) => category.rows);
    expect(rows.find((row) => row.name === 'Name')?.value).toBe('');
    expect(rows.find((row) => row.name === 'x')?.value).toBe('');
    expect(rows.some((row) => row.name === 'bgColor')).toBe(false);
    expect(two.events).toEqual([]);
    const timer = await python.call<PropertiesView>('properties_view', ['tick']);
    expect(timer.categories.map((category) => category.name)).toEqual(['Identity', 'Behavior']);
    const enabled = timer.categories[1]?.rows.find((row) => row.name === 'enabled');
    expect(enabled).toMatchObject({ type: 'boolean', checked: false, value: 'false' });
  });

  it('changes values in one undo step, refuses a bad number and a taken name', async () => {
    await open('fifteen');
    type Reply = { error: string | null; warnings: string[]; names: string[]; state: DocState };
    const height = await python.call<Reply>(
      'properties_set',
      ['btn_play', 'btn_options'],
      'height',
      '70',
    );
    expect(height.error).toBeNull();
    expect(height.state.undoText).toBe('Change height');
    const view = await python.call<PropertiesView>('properties_view', ['btn_options']);
    expect(view.categories[1]?.rows.find((row) => row.name === 'height')?.value).toBe('70');
    const undo = await python.call<DocState>('doc_undo');
    expect(undo.canUndo).toBe(false);

    const bad = await python.call<Reply>('properties_set', ['btn_play'], 'width', 'wide');
    expect(bad.error).toBe('Invalid value for width');
    expect(bad.state.canUndo).toBe(false);
    const taken = await python.call<Reply>('properties_set', ['btn_play'], 'Name', 'btn_options');
    expect(taken.error).not.toBeNull();
    const renamed = await python.call<Reply>('properties_set', ['btn_play'], 'Name', 'btn_start');
    expect(renamed.names).toEqual(['btn_start']);
    expect(renamed.state.undoText).toBe('Rename Widget');
    expect(await python.call('widget_handler', 'btn_start')).toBe('btn_start_clicked');

    const made = await python.call<{ handler: string; state: DocState }>(
      'event_handler',
      'menu_bg',
      'CLICKED',
    );
    expect(made.handler).toBe('menu_bg_clicked');
    expect(made.state.undoText).toBe('Create Handler');
  });

  it('places, copies, aligns and orders widgets as ui/designer/scene.py', async () => {
    await open('fifteen');
    const menu = state.pages[0]?.id ?? '';
    type Created = { created: string[]; state: DocState };
    // a click on a container places the widget inside it, at the point in its coordinates
    const added = await python.call<Created>(
      'design_add_widget',
      menu,
      'button',
      400,
      20,
      null,
      false,
      8,
    );
    expect(added.created).toEqual(['button1']);
    expect(added.state.undoText).toBe('Add Widget');
    let page = await python.call<DesignPage>('design_page', menu);
    expect(page.widgets.find((w) => w.name === 'button1')?.parentId).toBeNull();
    const background = page.widgets.find((w) => w.name === 'menu_bg')?.id ?? '';
    const inside = await python.call<Created>(
      'design_add_widget',
      menu,
      'label',
      100,
      100,
      background,
      true,
      1,
    );
    page = await python.call<DesignPage>('design_page', menu);
    const label = page.widgets.find((w) => w.name === inside.created[0]);
    expect(label?.parentId).toBe(background);
    expect(label?.props.x).toBe(100 - Number(label?.props.width) / 2);
    // a component goes to the page, and is not selected
    expect(
      (await python.call<Created>('design_add_widget', menu, 'timer', 0, 0, null, true, 1)).created,
    ).toEqual([]);
    // copy and paste: new names, 12 pixels further
    await python.call('design_copy', menu, ['btn_play'], false);
    const pasted = await python.call<Created>('design_paste', menu);
    page = await python.call<DesignPage>('design_page', menu);
    const copy = page.widgets.find((w) => w.name === pasted.created[0]);
    expect(copy?.props.x).toBe(132);
    expect(copy?.type).toBe('button');
    // align and the order
    const aligned = await python.call<DocState>(
      'design_align',
      menu,
      ['btn_play', 'btn_options'],
      'right',
    );
    expect(aligned.undoText).toBe('Align widgets');
    const z = await python.call<DocState>('design_z', menu, ['menu_bg'], true);
    expect(z.undoText).toBe('Widget Order');
    page = await python.call<DesignPage>('design_page', menu);
    expect(page.widgets.at(-1)?.name).not.toBe('menu_bg'); // its children come after it
    const geometry = await python.call<DocState>('design_geometry', {
      [background]: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(geometry.undoText).toBe('Change Geometry');
  });

  it('lists Objects and Procedures as ui/code/editor.py, and makes a handler by typing', async () => {
    await open('fifteen');
    const objects = await python.call<{ key: string; label: string }[]>('code_objects');
    expect(objects[0]).toEqual({ key: 'module', label: '(General)' });
    expect(objects.some((o) => o.key === 'page:Menu' && o.label === 'Page: Menu')).toBe(true);
    expect(objects.some((o) => o.key === 'widget:beeper')).toBe(false); // no events
    const listed = await python.call<{
      procedures: { event: string; handler: string; exists: boolean }[];
      default: string;
    }>('code_procedures', 'widget:menu_title');
    expect(listed.default).toBe('menu_title_clicked');
    expect(listed.procedures.find((p) => p.event === 'CLICKED')?.exists).toBe(false);
    const opened = await python.call<{ current: Record<string, string>; signature: string }>(
      'code_open',
      'widget:menu_title',
      'menu_title_clicked',
    );
    expect(opened.current).toEqual({
      kind: 'handler',
      name: 'menu_title_clicked',
      owner: 'menu_title',
      event: 'CLICKED',
    });
    expect(opened.signature).toBe('def menu_title_clicked(e):');
    const made = await python.call<DocState>(
      'code_set',
      'handler',
      'menu_title_clicked',
      'pass',
      7,
      'menu_title',
      'CLICKED',
    );
    expect(made.undoText).toBe('Edit Code');
    expect(await python.call('code_object_of', 'menu_title_clicked')).toBe('widget:menu_title');
    const actions = await python.call<{ title: string; actions: { code: string }[] }[]>(
      'code_actions',
      'menu_title',
      null,
    );
    expect(actions.at(-1)?.title).toBe('Screen');
    expect(actions[0]?.actions[0]?.code).toContain('§');
    expect(await python.call('code_entries', 'menu_t')).toEqual([
      ['menu_tile_a', 'ui.menu_tile_a.'],
      ['menu_tile_b', 'ui.menu_tile_b.'],
      ['menu_tile_c', 'ui.menu_tile_c.'],
      ['menu_tile_gap', 'ui.menu_tile_gap.'],
      ['menu_title', 'ui.menu_title.'],
    ]);
  });

  it('changes the project settings and keeps profiles and blocks in the configuration folder', async () => {
    await open('weather');
    const view = await python.call<{
      profiles: { key: string; name: string }[];
      current: string | null;
    }>('project_settings_view');
    expect(view.current).toBe('0'); // weather names a board: its own copy comes first
    const key = view.profiles.find((p) => p.name.startsWith('Waveshare'))?.key ?? null;
    const changed = await python.call<{ state: DocState }>(
      'doc_project_settings',
      240,
      240,
      key,
      'adapt',
    );
    expect(changed.state.undoText).toBe('Change Project Settings');
    expect(changed.state.board).toBe('waveshare_rp2350_touch_lcd_4_240');
    expect((await python.call<{ error: string | null }>('doc_update_profile')).error).toBeNull();

    const manager = await python.call<{ profiles: { id: string }[]; adapters: string[] }>(
      'profiles_manager',
    );
    const custom = await python.call<{ id: string; name: string }>('profile_new', null);
    expect(custom.id.startsWith('custom_')).toBe(true);
    await python.call('profiles_apply', [...manager.profiles, { ...custom, name: 'Mine' }]);
    const files = await python.call<string[]>('config_files');
    expect(files).toContain('board-profiles.json');
    const after = await python.call<{ profiles: { name: string }[] }>('profiles_manager');
    expect(after.profiles.map((p) => p.name)).toContain('Mine');

    const blocks = await python.call<{ blocks: { id: string; origin: string }[] }>('blocks_view');
    expect(blocks.blocks.every((b) => b.origin === 'standard')).toBe(true);
  });

  it('measures the budget with measure_budget, mpy-cross answered by the page', async () => {
    await open('fifteen');
    const prepared = await python.call<{ jobs: { path: string; args: string[] }[] }>(
      'budget_prepare',
      null,
    );
    expect(prepared.jobs.some((job) => job.path.endsWith('/ui.py'))).toBe(true);
    // without the page's compilations: the project does not compile, as measure_budget says
    expect(await python.call('budget_measure', null)).toBeNull();
    const texts = await python.call<{ text: string; level: number }>(
      'budget_texts',
      { flash: 900000, ram: 100 },
      { flash: 1000000 },
    );
    expect(texts).toMatchObject({ text: 'Flash 879 KB / 977 KB · RAM ~0 KB', level: 1 });
  });
});
