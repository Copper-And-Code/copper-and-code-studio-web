// The project tree, as upstream's ui/main_tree.py builds it: each page with its widgets, then the
// Python Modules; all expanded. Selecting a page shows its canvas, selecting a widget selects it
// there; a double click or Enter opens a widget's handler or a module; the context menu has the
// page actions, or the module actions on the Python Modules branch.
import { LitElement, css, html, nothing } from 'lit';
import type { DesignTree } from '../app/designer.ts';
import { tr } from '../i18n/tr.ts';
import type { ContextMenu } from './context-menu.ts';
import './context-menu.ts';
import type { MenuItem } from './menu-bar.ts';

/** A node: page:<id>, widget:<name>, modules, pymodule:<id>. */
export type TreeKey = `page:${string}` | `widget:${string}` | 'modules' | `pymodule:${string}`;

interface Node {
  key: TreeKey;
  label: string;
  testid: string;
  title?: string;
  children?: Node[];
}

export class ProjectTree extends LitElement {
  static override properties = {
    tree: { attribute: false },
    modules: { attribute: false },
    selected: { attribute: false },
    collapsed: { state: true },
  };

  tree: DesignTree = { pages: [], components: [] };
  modules: { id: string; name: string }[] = [];
  /** The node selected, as the tree's current item; set from outside when the canvas changes. */
  selected: TreeKey | null = null;
  collapsed = new Set<TreeKey>();
  onSelect: (key: TreeKey) => void = () => {};
  onActivate: (key: TreeKey) => void = () => {};
  menuFor: (key: TreeKey | null) => MenuItem[] = () => [];

  static override styles = css`
    :host {
      display: block;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    ul ul {
      padding-left: 14px;
    }
    [role='treeitem'] {
      display: block;
      width: 100%;
      text-align: left;
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    [role='treeitem'][aria-selected='true'] {
      background: var(--selection);
    }
    [role='treeitem']:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    /* drawn by CSS, so that the item's text is its name alone */
    .chevron {
      display: inline-block;
      width: 1em;
      color: var(--muted);
    }
    .chevron[data-state='open']::before {
      content: '▾' / '';
    }
    .chevron[data-state='closed']::before {
      content: '▸' / '';
    }
  `;

  private nodes(): Node[] {
    const pages: Node[] = this.tree.pages.map((page) => ({
      key: `page:${page.id}`,
      label: page.name,
      testid: 'page',
      children: page.widgets.map((widget) => ({
        key: `widget:${widget.name}` as TreeKey,
        label: `${widget.name} — ${widget.type}`,
        testid: 'tree-widget',
      })),
    }));
    return [
      ...pages,
      {
        key: 'modules',
        label: tr('Python Modules'),
        testid: 'modules',
        title: tr(
          '.py files of the project, imported by name from handlers, the general code and each other',
        ),
        children: this.modules.map((module) => ({
          key: `pymodule:${module.id}` as TreeKey,
          label: `${module.name}.py`,
          testid: 'module',
        })),
      },
    ];
  }

  private visible(): TreeKey[] {
    const keys: TreeKey[] = [];
    const walk = (nodes: Node[]) => {
      for (const node of nodes) {
        keys.push(node.key);
        if (node.children && !this.collapsed.has(node.key)) walk(node.children);
      }
    };
    walk(this.nodes());
    return keys;
  }

  private choose(key: TreeKey): void {
    this.selected = key;
    this.onSelect(key);
  }

  private toggle(key: TreeKey): void {
    const collapsed = new Set(this.collapsed);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    this.collapsed = collapsed;
  }

  private focusKey(key: TreeKey | undefined): void {
    if (!key) return;
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(),
    );
  }

  private keys(event: KeyboardEvent, node: Node): void {
    const keys = this.visible();
    const index = keys.indexOf(node.key);
    const menu = this.renderRoot.querySelector<ContextMenu>('lms-context-menu');
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      this.choose(node.key);
      menu?.show(event, this.menuFor(node.key), tr('Project'));
      return;
    }
    let next: TreeKey | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = keys[index + 1];
        break;
      case 'ArrowUp':
        next = keys[index - 1];
        break;
      case 'Home':
        next = keys[0];
        break;
      case 'End':
        next = keys.at(-1);
        break;
      case 'ArrowRight':
        if (node.children && this.collapsed.has(node.key)) this.toggle(node.key);
        else if (node.children?.length) next = node.children[0]?.key;
        break;
      case 'ArrowLeft':
        if (node.children && !this.collapsed.has(node.key)) this.toggle(node.key);
        else next = this.parentOf(node.key);
        break;
      case 'Enter':
        this.onActivate(node.key);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) {
      this.choose(next);
      this.focusKey(next);
    }
  }

  private parentOf(key: TreeKey): TreeKey | undefined {
    return this.nodes().find((node) => node.children?.some((child) => child.key === key))?.key;
  }

  private renderNodes(nodes: Node[], level: number): unknown {
    const focusable = this.selected ?? this.nodes()[0]?.key;
    return nodes.map((node) => {
      const open = node.children ? !this.collapsed.has(node.key) : undefined;
      return html`<li role="none">
        <button
          type="button"
          role="treeitem"
          data-key=${node.key}
          data-testid=${node.testid}
          aria-level=${level}
          aria-expanded=${open === undefined ? nothing : String(open)}
          aria-selected=${String(this.selected === node.key)}
          tabindex=${focusable === node.key ? 0 : -1}
          title=${node.title ?? nothing}
          @click=${(event: MouseEvent) => {
            if ((event.target as HTMLElement).classList.contains('chevron')) this.toggle(node.key);
            else this.choose(node.key);
          }}
          @dblclick=${() => this.onActivate(node.key)}
          @keydown=${(event: KeyboardEvent) => this.keys(event, node)}
          @contextmenu=${(event: MouseEvent) => {
            this.choose(node.key);
            this.renderRoot
              .querySelector<ContextMenu>('lms-context-menu')
              ?.show(event, this.menuFor(node.key), tr('Project'));
          }}
        >
          <span
            class="chevron"
            data-state=${open === undefined ? 'leaf' : open ? 'open' : 'closed'}
          ></span
          >${node.label}
        </button>
        ${
          node.children && open
            ? html`<ul role="group">
                ${this.renderNodes(node.children, level + 1)}
              </ul>`
            : nothing
        }
      </li>`;
    });
  }

  override render() {
    return html`<ul role="tree" aria-label=${tr('Project')}>
        ${this.renderNodes(this.nodes(), 1)}
      </ul>
      <lms-context-menu></lms-context-menu>`;
  }
}

customElements.define('lms-project-tree', ProjectTree);

declare global {
  interface HTMLElementTagNameMap {
    'lms-project-tree': ProjectTree;
  }
}
