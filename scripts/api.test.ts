/** The logical root API has two published declaration routes and a complete reviewed page set. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

await test('API check refuses missing inputs, signature drift, missing CJS and stale or extra pages without accepting them', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/api-'));
  try {
    await mkdir(join(root, 'dist/cjs'), { recursive: true });
    for (const path of ['package.json', 'api-extractor.json']) {
      await copyFile(path, join(root, path));
    }
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['dist/**/*.ts'],
      }),
    );
    const input =
      '/** A public greeting. @public */\nexport declare function greet(): string;\n';
    for (const path of [
      'dist/index.d.ts',
      'dist/sh-codemod.d.ts',
      'dist/cjs/sh-codemod.d.cts',
    ]) {
      await writeFile(join(root, path), input);
    }
    // The fixture uses a real rollup so comparison is against Extractor's declaration contract.
    const buildConfigPath = join(root, 'api-extractor.json');
    const buildConfig = ExtractorConfig.loadFile(buildConfigPath);
    buildConfig.apiReport = { ...buildConfig.apiReport, enabled: false };
    buildConfig.docModel = { ...buildConfig.docModel, enabled: false };
    buildConfig.dtsRollup = { ...buildConfig.dtsRollup, enabled: true };
    const built = Extractor.invoke(
      ExtractorConfig.prepare({
        configObject: buildConfig,
        configObjectFullPath: buildConfigPath,
        packageJsonFullPath: join(root, 'package.json'),
      }),
    );
    assert.ok(built.succeeded);
    await copyFile(
      join(root, 'dist/sh-codemod.d.ts'),
      join(root, 'dist/cjs/sh-codemod.d.cts'),
    );
    const invoke = (mode: string) =>
      spawnSync(process.execPath, [resolve('scripts/api.ts'), mode], {
        cwd: root,
        encoding: 'utf8',
      });
    assert.notEqual(invoke('check').status, 0);
    const update = invoke('update');
    assert.equal(update.status, 0, update.stdout + update.stderr);
    const page = join(root, 'docs/api/sh-codemod.greet.md');
    assert.match(await readFile(page, 'utf8'), /greet/);
    assert.equal(invoke('check').status, 0);
    await rm(page);
    assert.notEqual(
      invoke('check').status,
      0,
      'a missing generated page must fail',
    );
    assert.equal(invoke('update').status, 0);
    for (const path of [page, join(root, 'docs/api/stale.md')]) {
      await writeFile(path, 'stale page\n');
      assert.notEqual(invoke('check').status, 0);
      assert.equal(await readFile(path, 'utf8'), 'stale page\n');
      assert.equal(invoke('update').status, 0);
    }
    const esmPath = join(root, 'dist/sh-codemod.d.ts');
    const cjsPath = join(root, 'dist/cjs/sh-codemod.d.cts');
    const accepted = await readFile(esmPath, 'utf8');
    await writeFile(esmPath, accepted.replace('string', 'number'));
    await writeFile(cjsPath, accepted.replace('string', 'number'));
    assert.notEqual(
      invoke('check').status,
      0,
      'both published rolls must match the compiler input',
    );
    await writeFile(esmPath, accepted);
    await writeFile(cjsPath, accepted);
    const cjs = join(root, 'dist/cjs/sh-codemod.d.cts');
    await rm(cjs);
    assert.notEqual(invoke('check').status, 0);
    await writeFile(cjs, accepted);
    const report = await readFile(
      join(root, 'api-report/sh-codemod.api.md'),
      'utf8',
    );
    await writeFile(
      join(root, 'dist/index.d.ts'),
      input.replace('greet()', 'greet(name: string)'),
    );
    assert.notEqual(invoke('check').status, 0);
    assert.equal(
      await readFile(join(root, 'api-report/sh-codemod.api.md'), 'utf8'),
      report,
    );
    await writeFile(join(root, 'dist/index.d.ts'), input);
    await writeFile(cjs, accepted.replace('string', 'number'));
    assert.notEqual(invoke('check').status, 0);
    await writeFile(cjs, accepted);
    await cp(
      join(root, 'dist/sh-codemod.d.ts'),
      join(root, 'dist/unrelated.d.ts'),
    );
    const config: unknown = JSON.parse(
      await readFile(join(root, 'api-extractor.json'), 'utf8'),
    );
    assert.ok(typeof config === 'object' && config !== null);
    for (const override of [
      { docModel: { enabled: false } },
      { apiReport: { enabled: false } },
    ]) {
      await writeFile(
        join(root, 'api-extractor.json'),
        JSON.stringify({ ...config, ...override }),
      );
      assert.notEqual(invoke('check').status, 0);
    }
    await writeFile(
      join(root, 'api-extractor.json'),
      JSON.stringify({
        ...config,
        mainEntryPointFilePath: '<projectFolder>/dist/unrelated.d.ts',
      }),
    );
    assert.notEqual(invoke('check').status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
