/** Project releases from one disposable Changesets view; supported legacy migration must never repair checked source. */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';

/** Validate only the installed PreState's required contract; legacy and compatible extra fields belong to its supported reader. */
async function validatePresentPreState(root: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(join(root, '.changeset/pre.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  // Parsing first distinguishes a missing file from present falsy JSON that the reader treats as absent.
  const state: unknown = JSON.parse(contents);
  if (
    typeof state !== 'object' ||
    state === null ||
    Array.isArray(state) ||
    !('mode' in state) ||
    (state.mode !== 'pre' && state.mode !== 'exit') ||
    !('tag' in state) ||
    typeof state.tag !== 'string'
  ) {
    throw new Error(
      'Invalid prerelease state: expected an object with mode pre or exit and a string tag',
    );
  }
}

/**
 * Keep actual source package identities and planner instances while config, state and changesets
 * are read from one copied tree. The supported reader migrates that copy before changesets are
 * read, matching CLI ordering without a race against source checks. Temporary inputs are owned
 * by this call and removed on copying, validation, reading or planning failure too.
 * @internal
 */
export async function projectReleasePlan(
  root: string,
): Promise<ReturnType<typeof assembleReleasePlan>> {
  const packages = await getPackages(root);
  const snapshot = await mkdtemp(join(tmpdir(), 'sh-codemod-release-plan-'));
  try {
    await cp(
      join(packages.rootDir, '.changeset'),
      join(snapshot, '.changeset'),
      {
        recursive: true,
        // Library writes must target copied bytes rather than a link back into source.
        dereference: true,
      },
    );
    // readConfig uses packages.rootDir even when a cwd is supplied; only its input location changes.
    const settings = await readConfig(snapshot, {
      ...packages,
      rootDir: snapshot,
    });
    if (settings.errors !== undefined) {
      throw new Error(
        `Invalid Changesets config: ${settings.errors.join('; ')}`,
      );
    }
    for (const warning of settings.warnings) {
      console.warn(warning);
    }
    await validatePresentPreState(snapshot);
    const preState = await readPreState(snapshot);
    const changesets = await readChangesets(snapshot);
    return assembleReleasePlan(changesets, packages, settings.config, preState);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
