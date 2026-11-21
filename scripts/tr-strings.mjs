// The texts the web IDE translates: every tr('…') and N_('…') of src/ with a literal text, found with the
// TypeScript parser. tests/unit/translations.test.ts checks that each one is in upstream's it.json
// or in src/i18n/it-web.json; run alone, it lists the ones in neither.
//
//   node scripts/tr-strings.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sources(folder, out = []) {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** {text: the first file:line that translates it}, and the tr() calls without a literal text. */
export function trStrings(root = ROOT) {
  const texts = new Map();
  const dynamic = [];
  for (const file of sources(join(root, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['tr', 'N_'].includes(node.expression.text)
      ) {
        const where = `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const text = node.arguments[0];
        if (text && (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text))) {
          if (!texts.has(text.text)) texts.set(text.text, where);
        } else {
          dynamic.push(where);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { texts, dynamic };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { texts, dynamic } = trStrings();
  const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  const upstream = read('upstream/copper_and_code_studio/translations/it.json');
  let web = {};
  try {
    web = read('src/i18n/it-web.json');
  } catch {
    // not made yet
  }
  const missing = [...texts.keys()].filter((text) => !(text in upstream) && !(text in web));
  console.log(
    `${texts.size} texts, ${missing.length} without a translation, ${dynamic.length} tr() of a value`,
  );
  console.log(
    JSON.stringify(Object.fromEntries(missing.map((text) => [text, texts.get(text)])), null, 1),
  );
  if (process.argv.includes('--dynamic')) console.log(dynamic.join('\n'));
}
