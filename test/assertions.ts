/** Runtime assertions keep fixture evidence untrusted until its shape or presence is established. */
import assert from 'node:assert/strict';

/** JSON objects may carry arbitrary fields; every value remains unknown for the caller to inspect. */
export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}
