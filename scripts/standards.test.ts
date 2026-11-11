/** Accepted tooling must cover maintained code and reserve owner-controlled release boundaries. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/** Tool configuration is untrusted JSON until its object shape is verified. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}

await test('strict checks and complete API documentation are executable root responsibilities', async () => {
  const manifest = record(JSON.parse(await readFile('package.json', 'utf8')));
  const scripts = record(manifest.scripts);
  for (const name of [
    'check:lint-ts',
    'check:format',
    'check:knip',
    'check:syncpack',
    'check:changesets',
    'check:versions',
    'test:ecosystem-map',
    'build:docs',
  ]) {
    assert.equal(typeof scripts[name], 'string', name);
  }
  const compiler = record(
    record(JSON.parse(await readFile('tsconfig.json', 'utf8'))).compilerOptions,
  );
  assert.equal(compiler.noUncheckedIndexedAccess, true);
  const api = record(JSON.parse(await readFile('api-extractor.json', 'utf8')));
  assert.equal(record(api.docModel).enabled, true);
  assert.equal(record(manifest.dependencies)['sh-ast'], '0.10.0');
  assert.deepEqual(Object.keys(record(manifest.dependencies)), ['sh-ast']);
});

await test('ordinary CI exposes independent G1/G2/map checks and release runs only through Changesets on push to main', async () => {
  const ci = record(
    JSON.parse(
      (await readFile('.github/workflows/ci.yml', 'utf8')).replace(
        /^#.*$/gmu,
        '',
      ),
    ),
  );
  const job = record(record(ci.jobs).validation);
  assert.ok(Array.isArray(job.steps));
  const steps = job.steps.map((step: unknown) => record(step));
  for (const command of [
    'check:changesets',
    'check:versions',
    'test:ecosystem-map',
  ]) {
    const step = steps.find(
      (item) =>
        typeof item.run === 'string' && item.run.endsWith(`pnpm ${command}`),
    );
    assert.ok(step, command);
    assert.equal(step.if, '${{ !cancelled() }}');
  }
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  assert.doesNotMatch(release, /workflow_dispatch/);
  assert.match(release, /changesets\/action\/publish@[0-9a-f]{40}/);
  assert.doesNotMatch(release, /changesets\/action@/);
  assert.match(release, /mike-north\/sh-codemod/);
  assert.doesNotMatch(release, /--provenance|secrets\.(?!GITHUB_TOKEN)/);
});
