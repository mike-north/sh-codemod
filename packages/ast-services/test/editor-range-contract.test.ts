/** A corrupt parser snapshot must never turn an interior UTF-8 byte into a text edit. */
import { expect, it, vi } from 'vitest';
import type { Node } from 'sh-ast';
vi.mock('sh-ast', async (importOriginal) => {
  const upstream = await importOriginal<typeof import('sh-ast')>();
  return {
    ...upstream,
    parseWithPositionsSync(text: string, options: import('sh-ast').ParseOptions) {
      const parsed = upstream.parseWithPositionsSync(text, options);
      return {
        ...parsed,
        Positions: {
          get(node: Node) {
            const observed = parsed.Positions.get(node);
            if (node.Type !== 'Lit' || observed === undefined) return observed;
            return { ...observed, Pos: { ...observed.Pos, Offset: 6 } };
          },
        },
      };
    },
  };
});
import { createEditor } from '../src/index.js';
it('identifies non-character editor bounds and leaves the queue untouched', () => {
  const editor = createEditor('echo 🎉\n');
  const literal = editor.ast.Stmts?.[0]?.Cmd;
  if (literal?.Type !== 'CallExpr') throw new Error('Expected echo call');
  const node = literal.Args?.[1]?.Parts?.[0];
  if (node === undefined) throw new Error('Expected emoji literal');
  expect(() => {
    editor.replaceNode(node, 'bad');
  }).toThrow(RangeError);
  expect(() => {
    editor.replaceNode(node, 'bad');
  }).toThrow(expect.objectContaining({ code: 'ESLINT_SH_EDIT_RANGE' }));
  expect(editor.apply()).toBe('echo 🎉\n');
});
