/**
 * Publishes the api-extractor declaration rollup under the extension TypeScript requires
 * for a `require` condition.
 *
 * The rollup is a `.d.ts`, which a `"type": "module"` package makes ESM; a CommonJS consumer
 * resolving it would be told it is "masquerading as ESM". The same declarations are valid as
 * a `.d.cts`, so `exports.require.types` points at that copy.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

mkdirSync(join(distDir, 'cjs'), { recursive: true });
copyFileSync(join(distDir, 'ast-services.d.ts'), join(distDir, 'cjs', 'ast-services.d.cts'));
