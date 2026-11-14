// Messages are upstream's English source strings, so that upstream's translations
// (translations/it.json) can be applied to them as they are (phase 9). Until then: English,
// with {name} placeholders filled in, as upstream's tr() does.
export function tr(text: string, values: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
