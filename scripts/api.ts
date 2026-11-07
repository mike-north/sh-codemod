/** One logical public root is reviewed from compiler declarations and shipped in both module formats. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { record } from './publishing.ts';

/** Full directory contents make missing and extra generated pages observable. */
async function contents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [name, text] of Object.entries(await contents(path))) {
        result[`${entry.name}/${name}`] = text;
      }
    } else if (entry.isFile()) {
      result[entry.name] = await readFile(path, 'utf8');
    } else {
      throw new Error(`API documentation must contain ordinary files: ${path}`);
    }
  }
  return result;
}

try {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== 'check' && mode !== 'update')) {
    throw new Error('Expected exactly one API mode: check or update');
  }
  const root = process.cwd();
  const manifest = record(
    JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
  );
  const routes = record(manifest.exports);
  const api = record(routes['.']);
  // These are deliberately the accepted package routes, not a generic export resolver.
  if (
    manifest.name !== 'sh-codemod' ||
    Object.keys(api).sort().join(',') !== 'import,require' ||
    routes['./package.json'] !== './package.json' ||
    'typesVersions' in manifest ||
    'typings' in manifest ||
    manifest.types !== './dist/sh-codemod.d.ts' ||
    Object.keys(routes).some((key) => key !== '.' && key !== './package.json')
  ) {
    throw new Error('Unexpected public root declaration routing');
  }
  for (const [condition, types, runtime] of [
    ['import', './dist/sh-codemod.d.ts', './dist/index.js'],
    ['require', './dist/cjs/sh-codemod.d.cts', './dist/cjs/index.js'],
  ]) {
    if (
      condition === undefined ||
      types === undefined ||
      runtime === undefined
    ) {
      throw new Error('Missing declaration route contract');
    }
    const route = record(api[condition]);
    if (
      Object.keys(route).length !== 2 ||
      Object.keys(route)[0] !== 'types' ||
      route.types !== types ||
      route.default !== runtime
    ) {
      throw new Error(`Unexpected ${condition} declaration route`);
    }
  }
  const esm = await readFile(join(root, 'dist/sh-codemod.d.ts'), 'utf8');
  const cjs = await readFile(join(root, 'dist/cjs/sh-codemod.d.cts'), 'utf8');
  if (esm !== cjs) {
    throw new Error('Published ESM/CJS declaration contracts differ');
  }
  const path = join(root, 'api-extractor.json');
  const config = ExtractorConfig.loadFileAndPrepare(path);
  // Source input and published rollup are separate build responsibilities.
  if (
    config.mainEntryPointFilePath !== join(root, 'dist/index.d.ts') ||
    config.untrimmedFilePath !== join(root, 'dist/sh-codemod.d.ts') ||
    !config.apiReportEnabled ||
    !config.docModelGenerationOptions
  ) {
    throw new Error(
      'API input, rollup, report and documentation model must cover the public root',
    );
  }
  if (mode === 'update') {
    await mkdir(config.reportFolder, { recursive: true });
  }
  await mkdir(join(root, 'temp'), { recursive: true });
  const temporary = await mkdtemp(join(root, 'temp/api-'));
  const generated = join(temporary, 'docs');
  const model = join(temporary, 'model');
  const output = join(root, 'docs/api');
  try {
    await mkdir(model);
    const raw = ExtractorConfig.loadFile(path);
    // Recreate the published contract in isolation; check mode never repairs shipped rolls.
    raw.dtsRollup = {
      ...raw.dtsRollup,
      enabled: true,
      untrimmedFilePath: join(temporary, 'sh-codemod.d.ts'),
    };
    raw.docModel = {
      ...raw.docModel,
      enabled: true,
      apiJsonFilePath: join(model, 'sh-codemod.api.json'),
    };
    const prepared = ExtractorConfig.prepare({
      configObject: raw,
      configObjectFullPath: path,
      packageJsonFullPath: join(root, 'package.json'),
    });
    const result = Extractor.invoke(prepared, {
      localBuild: mode === 'update',
    });
    if (!result.succeeded) {
      throw new Error('API report drift or extraction failure');
    }
    if ((await readFile(join(temporary, 'sh-codemod.d.ts'), 'utf8')) !== esm) {
      throw new Error(
        'Published declaration rollup drift from the compiler input',
      );
    }
    const documenter = fileURLToPath(
      new URL(
        './bin/api-documenter',
        import.meta.resolve('@microsoft/api-documenter/package.json'),
      ),
    );
    const run = spawnSync(
      process.execPath,
      [documenter, 'markdown', '-i', model, '-o', generated],
      { encoding: 'utf8' },
    );
    if (run.error) {
      throw run.error;
    }
    if (run.status !== 0) {
      throw new Error(run.stdout + run.stderr);
    }
    if (mode === 'update') {
      await rm(output, { recursive: true, force: true });
      await cp(generated, output, { recursive: true });
    } else {
      const actual = await contents(output);
      const expected = await contents(generated);
      const names = new Set([...Object.keys(actual), ...Object.keys(expected)]);
      if ([...names].some((name) => actual[name] !== expected[name])) {
        throw new Error(
          'API documentation drift; run pnpm build:docs and review the changes',
        );
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(
    'Checked sh-codemod public root API and both declaration routes.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
