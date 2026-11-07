/**
 * Criterion 6 of https://github.com/mike-north/eslint-sh/issues/182: the README's worked
 * codemod example is executed here, from the README text itself, so it cannot go stale.
 *
 * The example is the first fenced `js` block after the `codemod-example` marker. Its `import`
 * lines are resolved to this package's source and to `sh-ast`, and its exported `result` is
 * compared with an output written by hand below (not copied from the README's comment).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as shAst from 'sh-ast';
import { describe, expect, it } from 'vitest';
import * as astServices from '../src/index.js';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

/** Extracts the README's codemod example source. */
function readmeExample(): string {
  const marker = readme.indexOf('<!-- codemod-example -->');
  if (marker < 0) throw new Error('README has no <!-- codemod-example --> marker');
  const match = /```js\r?\n([\s\S]*?)\r?\n```/.exec(readme.slice(marker));
  if (!match?.[1]) throw new Error('README has no js block after the codemod-example marker');
  return match[1].replaceAll('\r\n', '\n');
}

/**
 * Runs example source whose imports name `sh-codemod` or `sh-ast` and which ends
 * by exporting `result`, returning that value.
 */
function run(source: string): unknown {
  const modules: Record<string, unknown> = {
    'sh-codemod': astServices,
    'sh-ast': shAst,
  };
  const body = source
    .replace(/^import \{([^}]*)\} from '([^']+)';$/gm, (_all, names: string, from: string) => {
      if (!(from in modules)) throw new Error(`example imports unexpected module ${from}`);
      return `const {${names}} = modules[${JSON.stringify(from)}];`;
    })
    .replace(/^export const result =/m, 'const result =');
  return runInNewContext(
    `(() => {
${body}
return result;
})()`,
    { modules },
  );
}

describe('README codemod example', () => {
  it('produces the hand-written expected output, preserving everything else', () => {
    expect(run(readmeExample())).toBe(
      '#!/bin/sh\n# find 🎉 tools\nset -eu\ncommand -v   git  # where?\ncommand -v 你好\n',
    );
  });
});
