/** Maintainer-controlled stability policy: present inputs and every projected release must stay below 1.x. */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangesetFile } from '@changesets/parse';
import { projectReleasePlan } from './release-plan.ts';

/** All failures retain the maintainer's exclusive authority over stabilization. */
const policy =
  'This project stays in the 0.x series until the maintainer declares the shape stable. There is no override flag.';
/** Build products, dependencies and isolated evidence are not maintained source metadata. */
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'temp',
  'scratch',
  '.tmp',
  '.cache',
  '.pnpm-store',
]);

/** Walk source independently of workspace globs; links cannot redirect policy outside the tree. */
async function* files(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (entry.isFile()) {
      yield path;
    } else {
      throw new Error(`Cannot validate symbolic link: ${path}`);
    }
  }
}

/** The changeset check uses the CLI's parser, including quoted declarations and empty frontmatter. */
async function checkChangesets(root: string): Promise<void> {
  const directory = join(root, '.changeset');
  for await (const path of files(directory)) {
    if (!path.endsWith('.md') || relative(directory, path) === 'README.md') {
      continue;
    }
    const parsed = parseChangesetFile(await readFile(path, 'utf8'));
    for (const release of parsed.releases) {
      if (release.type === 'major') {
        throw new Error(
          `Major changeset is forbidden: ${path}: ${release.name}`,
        );
      }
    }
  }
}

/** Strict full SemVer, including prerelease numeric identifiers and an absolute end anchor. @internal */
export function zeroVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$(?![\s\S])/u.test(
      value,
    )
  );
}

/** Inspect every planner entry in order; privacy, inferred bumps and type-none confer no exemption. @internal */
export function assertPlanVersions(
  releases: readonly {
    readonly name: string;
    readonly newVersion?: string | undefined;
  }[],
): void {
  const forbidden = releases.filter(
    (release) => !zeroVersion(release.newVersion),
  );
  if (forbidden.length > 0) {
    throw new Error(
      forbidden
        .map(
          (release) =>
            `Projected version for ${release.name} must have a valid 0.x version; found ${String(release.newVersion)}`,
        )
        .join('; '),
    );
  }
}

/** The version check exempts private source metadata alone, then checks the entire supported library projection. */
async function checkVersions(root: string): Promise<void> {
  for await (const path of files(root)) {
    if (!path.endsWith('/package.json')) {
      continue;
    }
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      throw new Error(`Invalid package manifest: ${path}`);
    }
    if ('private' in manifest && manifest.private === true) {
      continue;
    }
    if (!('version' in manifest) || !zeroVersion(manifest.version)) {
      throw new Error(
        `${path} must have a valid 0.x version; found ${'version' in manifest ? String(manifest.version) : 'missing'}`,
      );
    }
  }
  const plan = await projectReleasePlan(root);
  assertPlanVersions(plan.releases);
}

// Importing shared version validation cannot execute a gate or start release tooling.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3) {
      throw new Error('Expected exactly one gate name: changesets or versions');
    }
    if (mode === 'changesets') {
      await checkChangesets(process.cwd());
    } else if (mode === 'versions') {
      await checkVersions(process.cwd());
    } else {
      throw new Error('Unknown gate; expected changesets or versions');
    }
    console.log(`Release gate passed: ${mode}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(policy);
    process.exitCode = 1;
  }
}
