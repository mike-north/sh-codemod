/** Shared numeric rendering keeps service-option errors truthful without changing their boundary. */
import { expect, it } from 'vitest';
import { createEditor, format } from '../src/index.js';
import type { FormatOptions } from '../src/index.js';

it.each([
  [NaN, 'NaN'],
  [Infinity, 'Infinity'],
  [-Infinity, '-Infinity'],
] as const)('identifies rejected %s in both service option diagnostics', (dialect, received) => {
  for (const service of [format, createEditor]) {
    try {
      // Invalid JavaScript values deliberately cross the typed public service boundary.
      service('echo hi\n', { dialect } as unknown as FormatOptions);
      throw new Error('Expected a rejected dialect');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      if (error instanceof Error) {
        expect(error.constructor).toBe(TypeError);
        expect(error.message).toContain(`${service.name} options.dialect: `);
        expect(error.message).toContain(`; received ${received}.`);
      }
      expect(error).toHaveProperty('code', 'ESLINT_SH_SERVICE_OPTION');
    }
  }
});
