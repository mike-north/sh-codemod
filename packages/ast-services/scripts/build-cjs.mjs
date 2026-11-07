/**
 * Derives the CommonJS build from the ESM output of `tsc`.
 *
 * The package source is authored once, as ESM. A second compile with a CommonJS `module`
 * setting is not possible under `NodeNext` for a `"type": "module"` package, so each emitted
 * ESM file is transpiled to CommonJS under `dist/cjs/`, where a nested `package.json` marks
 * `.js` files as CommonJS. Relative specifiers keep their `.js` extension and so resolve
 * within that directory.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const esmDir = join(packageDir, 'dist');
const cjsDir = join(esmDir, 'cjs');

mkdirSync(cjsDir, { recursive: true });
writeFileSync(join(cjsDir, 'package.json'), '{ "type": "commonjs" }\n');

for (const entry of readdirSync(esmDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const { outputText } = ts.transpileModule(readFileSync(join(esmDir, entry.name), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: false,
    },
    fileName: entry.name,
  });
  writeFileSync(join(cjsDir, entry.name), outputText);
}
