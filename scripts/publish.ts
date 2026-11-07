/**
 * Consume only the installed Changesets publish plan for this source workspace.
 * Validate the entire plan, then prepare and inspect workspace-aware archives
 * before native npm uploads any entry, preserving dependency chunk order.
 * Publication is an owner-dispatched main operation.
 */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { getPackages } from '@manypkg/get-packages';
import { zeroVersion } from './check-release.ts';
import {
  assertOwnerDispatch,
  checkRuntime,
  checkWorkflow,
  publicPackages,
  publicationConfig,
  record,
} from './publishing.ts';

/** Source identity fixes publication cwd; a plan can never supply arbitrary paths. */
interface Publication {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly access: 'public' | 'restricted';
  readonly tag: string;
}

/** An archive path is generated locally and remains bound to its validated source identity. */
interface PreparedPublication extends Publication {
  readonly archive: string;
}

/** Inspect direct npm dependency-map values; ordinary metadata text is not a specifier. */
function containsWorkspaceProtocol(manifest: Record<string, unknown>): boolean {
  for (const group of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const specifiers = manifest[group];
    if (
      typeof specifiers !== 'object' ||
      specifiers === null ||
      Array.isArray(specifiers)
    ) {
      continue;
    }
    const values: readonly unknown[] = Object.values(specifiers);
    if (
      values.some(
        (value) => typeof value === 'string' && value.startsWith('workspace:'),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Inspect actual tarball metadata without extracting package files into the checkout. */
async function validateArchive(release: PreparedPublication): Promise<void> {
  if (!(await lstat(release.archive)).isFile()) {
    throw new Error(`Invalid prepared archive: ${release.name}`);
  }
  const extracted = spawnSync(
    'tar',
    ['-xOf', release.archive, 'package/package.json'],
    { encoding: 'utf8' },
  );
  if (extracted.error || extracted.status !== 0) {
    throw new Error(
      `Invalid prepared archive for ${release.name}: ${extracted.error?.message ?? extracted.stderr}`,
    );
  }
  const manifest = record(JSON.parse(extracted.stdout));
  if (
    manifest.name !== release.name ||
    manifest.version !== release.version ||
    manifest.private === true
  ) {
    throw new Error(
      `Prepared archive identity does not match source/plan: ${release.name}@${release.version}`,
    );
  }
  if (containsWorkspaceProtocol(manifest)) {
    throw new Error(
      `Unresolved workspace protocol in prepared archive: ${release.name}`,
    );
  }
  const config = publicationConfig(manifest.publishConfig);
  if (
    (config.access !== undefined && config.access !== release.access) ||
    (config.tag !== undefined && config.tag !== release.tag)
  ) {
    throw new Error(
      `Unexpected prepared archive publication configuration: ${release.name}`,
    );
  }
}

/**
 * pnpm owns workspace-to-registry manifest conversion; npm owns OIDC upload.
 * Finish every pack before inspecting all archives so a later packing lifecycle
 * cannot silently alter an earlier artifact after it has already been checked.
 */
async function prepareArchives(
  releases: readonly Publication[],
  directory: string,
): Promise<readonly PreparedPublication[]> {
  const prepared: PreparedPublication[] = [];
  for (const [index, release] of releases.entries()) {
    const destination = join(directory, String(index));
    await mkdir(destination);
    const archive = join(destination, 'package.tgz');
    const packed = spawnSync('pnpm', ['pack', '--out', archive], {
      cwd: release.dir,
      encoding: 'utf8',
    });
    if (packed.error || packed.status !== 0) {
      throw new Error(
        `Archive packing failed for ${release.name}: ${packed.error?.message ?? packed.stderr + packed.stdout}`,
      );
    }
    prepared.push({ ...release, archive });
  }
  for (const release of prepared) {
    await validateArchive(release);
  }
  return prepared;
}

/** One-run artifact storage is removed on preparation, validation and upload failures too. */
let archiveDirectory: string | undefined;

try {
  assertOwnerDispatch();
  await checkWorkflow(process.cwd());
  checkRuntime();
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    throw new Error('Expected the Changesets publish plan path');
  }
  const value = record(JSON.parse(await readFile(path, 'utf8')));
  if (
    Object.keys(value).some((key) => !['version', 'plan'].includes(key)) ||
    value.version !== 1 ||
    !Array.isArray(value.plan)
  ) {
    throw new Error('Invalid Changesets publish plan schema');
  }
  const workspace = await getPackages(process.cwd());
  const config = await readConfig(workspace.rootDir, workspace);
  if (config.errors !== undefined) {
    throw new Error(`Invalid Changesets config: ${config.errors.join('; ')}`);
  }
  const pre = await readPreState(workspace.rootDir);
  const permittedTags = new Set(['latest']);
  if (pre !== undefined) {
    if (!/^[A-Za-z][\w.-]*$/.test(pre.tag)) {
      throw new Error('Invalid prerelease tag');
    }
    permittedTags.add(pre.tag);
  }
  const packages = new Map(
    (await publicPackages(process.cwd())).map((pkg) => [
      pkg.packageJson.name,
      pkg,
    ]),
  );
  const releases: Publication[] = [];
  const seen = new Set<string>();
  const chunks: readonly unknown[] = value.plan;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) {
      throw new Error('Invalid Changesets publish plan chunk');
    }
    const entries: readonly unknown[] = chunk;
    for (const entry of entries) {
      const release = record(entry);
      if (
        Object.keys(release).some(
          (key) => !['kind', 'name', 'version', 'access', 'tag'].includes(key),
        ) ||
        release.kind !== 'publish' ||
        typeof release.name !== 'string' ||
        !zeroVersion(release.version) ||
        typeof release.tag !== 'string' ||
        !permittedTags.has(release.tag)
      ) {
        throw new Error('Invalid or unexpected publication target');
      }
      if (seen.has(release.name)) {
        throw new Error(`Duplicate publication target: ${release.name}`);
      }
      seen.add(release.name);
      const pkg = packages.get(release.name);
      if (pkg?.packageJson.version !== release.version) {
        throw new Error(`Unexpected source package/version: ${release.name}`);
      }
      const manifest = record(
        JSON.parse(await readFile(join(pkg.dir, 'package.json'), 'utf8')),
      );
      const publishConfig = publicationConfig(manifest.publishConfig);
      const access: unknown = publishConfig.access ?? config.config.access;
      if (
        (access !== 'public' && access !== 'restricted') ||
        release.access !== access
      ) {
        throw new Error(`Unexpected publication access: ${release.name}`);
      }
      releases.push({
        dir: pkg.dir,
        name: release.name,
        version: release.version,
        access,
        tag: release.tag,
      });
    }
  }
  if (releases.length === 0) {
    console.log(
      packages.size === 0
        ? 'No publishable packages; nothing to do'
        : 'All package versions are already published; nothing to do',
    );
  } else {
    checkRuntime();
    const temporary = join(workspace.rootDir, '.tmp');
    await mkdir(temporary, { recursive: true });
    archiveDirectory = await mkdtemp(join(temporary, 'publish-archives-'));
    const prepared = await prepareArchives(releases, archiveDirectory);
    for (const release of prepared) {
      // This private repository cannot produce npm provenance attestations.
      // Native OIDC authentication is separate and needs no provenance flag.
      const result = spawnSync(
        'npm',
        [
          'publish',
          release.archive,
          '--access',
          release.access,
          '--tag',
          release.tag,
        ],
        { cwd: release.dir, stdio: 'inherit' },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`npm publication failed: ${release.name}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (archiveDirectory !== undefined) {
    await rm(archiveDirectory, { recursive: true, force: true });
  }
}
