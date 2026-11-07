/** Discover only maintained package tests; ignored extraction clones are never test inputs. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
