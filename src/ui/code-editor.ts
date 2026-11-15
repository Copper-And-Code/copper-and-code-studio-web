// The editor of the Code tab and of file tabs, as upstream's ui/code/editor.py CodeEditor:
// Python highlighting, line numbers, completion, the lines with errors marked.
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  closeBrackets,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { LitElement, css, html } from 'lit';

/**
 * ui/code/highlighter.py with ui/theme.py's CodeColors: keywords, strings, comments, numbers and
 * errors in the colours of the desktop, light or dark as the system (src/theme.css).
 */
const highlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.bool,
      tags.null,
      tags.self,
    ],
    color: 'var(--code-keyword)',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: tags.number, color: 'var(--code-number)' },
  { tag: tags.invalid, color: 'var(--code-error)' },
]);

/** The editor's own parts in the IDE's colours, which follow the system's light or dark. */
const look = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--panel)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },
});

/** What completes the dotted name before the cursor: names, or [label, text to insert]. */
export type CompletionProvider = (
  qualified: string,
) => (string | [string, string])[] | Promise<(string | [string, string])[]>;

/** core/actions.py CURSOR: where the cursor goes after an action is inserted. */
const CURSOR = '§';

const setErrors = StateEffect.define<number[]>();
const errorLine = Decoration.line({ class: 'cm-error-line' });

/** The lines with an error: a red band, as CodeEditor.show_errors paints them. */
const errorLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, transaction) {
    lines = lines.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setErrors)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      const doc = transaction.state.doc;
      for (const number of [...new Set(effect.value)].sort((a, b) => a - b)) {
        if (number >= 1 && number <= doc.lines) {
          const line = doc.line(number);
          builder.add(line.from, line.from, errorLine);
        }
      }
      lines = builder.finish();
    }
    return lines;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export class CodeEditor extends LitElement {
  static override properties = {
    label: {},
  };

  label = 'Code';
  private view: EditorView | null = null;
  private readonly editable = new Compartment();
  private pendingText = '';
  private loading = false;
  private locked = false;
  provider: CompletionProvider = () => [];
  /** Called on every change typed by the user, not on setText. */
  onChange: (text: string) => void = () => {};

  static override styles = css`
    :host {
      display: block;
      min-height: 0;
      height: 100%;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      background: var(--panel);
    }
    .host {
      height: 100%;
    }
    .cm-editor {
      height: 100%;
      font-size: 13px;
    }
    .cm-editor.cm-focused {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .cm-scroller {
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    }
    .cm-error-line {
      background: color-mix(in srgb, var(--danger) 18%, transparent);
    }
    .cm-gutters {
      background: var(--bg);
      color: var(--muted);
      border-right: 1px solid var(--border);
    }
    .cm-activeLine,
    .cm-activeLineGutter {
      background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    .cm-content {
      caret-color: var(--text);
    }
    .cm-editor {
      color: var(--text);
    }
  `;

  override firstUpdated(): void {
    const host = this.renderRoot.querySelector<HTMLElement>('.host');
    if (!host) return;
    this.view = new EditorView({
      parent: host,
      root: this.renderRoot as ShadowRoot,
      state: this.state(this.pendingText),
    });
  }

  private state(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        indentUnit.of('    '),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlight),
        look,
        python(),
        autocompletion({ override: [(context) => this.complete(context)] }),
        keymap.of([
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        errorLines,
        this.editable.of(EditorView.editable.of(!this.locked)),
        // in the Tab order also when read-only, so the code can be read from the keyboard
        EditorView.contentAttributes.of({ 'aria-label': this.label, tabindex: '0' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.loading) this.onChange(update.state.doc.toString());
        }),
      ],
    });
  }

  private async complete(context: CompletionContext): Promise<CompletionResult | null> {
    const word = context.matchBefore(/[A-Za-z_][\w.]*$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const qualified = word.text;
    const dot = qualified.lastIndexOf('.');
    if (dot < 0 && !context.explicit && qualified.length < 2) return null;
    const entries = await this.provider(qualified);
    if (!entries.length) return null;
    const options: Completion[] = entries.map((entry) =>
      typeof entry === 'string'
        ? { label: entry }
        : {
            label: entry[0],
            apply: (view: EditorView, _completion: Completion, from: number, to: number) =>
              this.insertAt(view, from, to, entry[1]),
          },
    );
    return { from: word.from + dot + 1, options, validFor: /^\w*$/ };
  }

  /**
   * CodeEditor.insert_code: the code without its CURSOR mark (§), the cursor left at the mark;
   * after a dot, the completion opens again.
   */
  private insertAt(view: EditorView, from: number, to: number, code: string): void {
    const mark = code.indexOf(CURSOR);
    const text = code.replace(CURSOR, '');
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + (mark >= 0 ? mark : text.length) },
      scrollIntoView: true,
    });
    // after the double click that asked for it, the focus would stay on the list (mark_line);
    // WebKit puts the caret at the start when the editor takes the focus back: set it again
    const anchor = view.state.selection.main.anchor;
    const inserted = view.state.doc;
    setTimeout(() => {
      view.focus();
      // only if nothing was typed meanwhile: then the caret is where the typing left it
      if (view.state.doc === inserted) view.dispatch({ selection: { anchor } });
      if (code.endsWith('.')) startCompletion(view);
    }, 0);
  }

  /**
   * CodePanel.insert_action: on a line that has text the code goes on a new line below, with
   * its indentation; then insert_code.
   */
  insertCode(code: string): void {
    const view = this.view;
    if (!view || this.locked) return;
    view.focus();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    if (line.text.trim()) {
      const indent = /^\s*/.exec(line.text)?.[0] ?? '';
      view.dispatch({ changes: { from: line.to, insert: `\n${indent}` } });
      const at = line.to + 1 + indent.length;
      this.insertAt(view, at, at, code);
    } else {
      this.insertAt(view, head, head, code);
    }
  }

  get text(): string {
    return this.view?.state.doc.toString() ?? this.pendingText;
  }

  /** New text, as when another file is opened: the undo history starts again. */
  setText(text: string): void {
    this.pendingText = text;
    if (!this.view) return;
    this.loading = true;
    try {
      this.view.setState(this.state(text));
    } finally {
      this.loading = false;
    }
  }

  /** Replaces the text keeping the undo history, as an outside change (undo in the project). */
  replaceText(text: string): void {
    if (!this.view || text === this.text) return;
    this.loading = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    } finally {
      this.loading = false;
    }
  }

  set readOnly(value: boolean) {
    this.locked = value;
    this.view?.dispatch({
      effects: this.editable.reconfigure(EditorView.editable.of(!value)),
    });
  }

  get readOnly(): boolean {
    return this.locked;
  }

  showErrors(lines: number[]): void {
    this.view?.dispatch({ effects: setErrors.of(lines) });
  }

  goToLine(line: number): void {
    const view = this.view;
    if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    view.focus();
  }

  override focus(): void {
    this.view?.focus();
  }

  override render() {
    return html`<div class="host"></div>`;
  }
}

customElements.define('lms-code-editor', CodeEditor);

declare global {
  interface HTMLElementTagNameMap {
    'lms-code-editor': CodeEditor;
  }
}
