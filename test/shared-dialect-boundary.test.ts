/** The standalone runtime consumes the public producer and owns no grammar vocabulary. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships only root syntax imports and no materialized grammar module', () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  expect(Object.keys(manifest.dependencies)).toEqual(['sh-ast']);
  expect(existsSync(new URL('src/shell-dialect.ts', root))).toBe(false);
  expect(existsSync(new URL('shared/', root))).toBe(false);
  for (const file of readdirSync(new URL('src/', root))) {
    const source = readFileSync(new URL(`src/${file}`, root), 'utf8');
    const externals = [...source.matchAll(/from ['"]([^.'"][^'"]*)['"]/gu)].map((match) => match[1]);
    expect(externals.every((specifier) => specifier === 'sh-ast')).toBe(true);
  }
  const entry = readFileSync(new URL('src/index.ts', root), 'utf8');
  expect(entry).toContain("export type { LangVariant } from 'sh-ast'");
});
