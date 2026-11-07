/** Build a self-contained package from current sources; stale output never enters an archive. */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

/** Resolve tools from this installation, independent of the caller's global toolchain. */
const require = createRequire(import.meta.url);
/** Package paths are anchored to this script so invocation cwd cannot redirect deletion. */
const root = fileURLToPath(new URL('../', import.meta.url));

/** A failed compiler or module conversion must refuse packaging rather than leave partial output. */
function run(args: readonly string[]): void {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
run(['scripts/build-cjs.mts']);
/** Build writes the declaration rollup; API report verification stays a separate read-only check. */
const configPath = fileURLToPath(
  new URL('../api-extractor.json', import.meta.url),
);
const config = ExtractorConfig.loadFile(configPath);
config.dtsRollup = { ...config.dtsRollup, enabled: true };
config.apiReport = { ...config.apiReport, enabled: false };
const result = Extractor.invoke(
  ExtractorConfig.prepare({
    configObject: config,
    configObjectFullPath: configPath,
    packageJsonFullPath: `${root}package.json`,
  }),
);
if (!result.succeeded) {
  process.exit(1);
}
run(['scripts/copy-cjs-types.mts']);
