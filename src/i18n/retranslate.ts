// Settings → Language, as upstream's ui/language.py apply_language: the language is set, kept in the
// settings, and everything shown is drawn again in it, without a restart. Every Lit element of the
// page, inside shadow roots too, renders again with tr() in the new language.
import { LitElement } from 'lit';
import { setLanguage } from './tr.ts';

function elements(root: Document | ShadowRoot, out: LitElement[] = []): LitElement[] {
  for (const element of root.querySelectorAll('*')) {
    if (element instanceof LitElement) out.push(element);
    if (element.shadowRoot) elements(element.shadowRoot, out);
  }
  return out;
}

export function applyLanguage(code: string): string {
  const selected = setLanguage(code);
  document.documentElement.lang = selected;
  for (const element of elements(document)) element.requestUpdate();
  return selected;
}
