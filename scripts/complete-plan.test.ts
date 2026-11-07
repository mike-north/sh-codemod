/** Policy inspects complete planner results without discarding private, inferred or type-none entries. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPlanVersions } from './check-release.ts';

await test('all forbidden releases are named in original plan order', () => {
  const releases = [
    { name: 'direct', newVersion: '1.0.0', type: 'major' },
    {
      name: 'private',
      newVersion: '1.1.0-next.0',
      type: 'minor',
      private: true,
    },
    { name: 'inferred', newVersion: '2.0.0', type: 'none' },
    { name: 'valid', newVersion: '0.9.0' },
  ];
  assert.throws(() => {
    assertPlanVersions(releases);
  }, /direct.*private.*inferred/s);
  assert.doesNotThrow(() => {
    assertPlanVersions([{ name: 'valid', newVersion: '0.9.0-next.1+build' }]);
  });
  assert.doesNotThrow(() => {
    assertPlanVersions([]);
  });
});
