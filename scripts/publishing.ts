/**
 * Release infrastructure only: validate the Changesets release workflow and authorize the
 * publishing step to run only for a push to main of the registered repository under OIDC.
 * No product assessment or readiness state is involved.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The npm trust identity must agree with the checked workflow and owner setup. @internal */
export const publisher = {
  owner: 'mike-north',
  repository: 'sh-codemod',
  workflow: 'release.yml',
  environment: 'npm',
} as const;

/** Runtime JSON is a dictionary only after its object shape is verified. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed service responses and workflow structures before using them. @internal */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected an object in publishing configuration');
  }
  return value;
}

/**
 * Validate that the release workflow keeps the identity npm trusted publishing registered
 * (repository, file name, environment) and the minimum authority the Changesets action needs.
 * @internal
 */
export async function checkWorkflow(root: string): Promise<void> {
  const text = await readFile(
    join(root, '.github/workflows', publisher.workflow),
    'utf8',
  );
  // The action's own GITHUB_TOKEN is the only secret; an npm credential would defeat OIDC.
  const secrets = [...text.matchAll(/secrets\.(\w+)/gu)].map(
    (match) => match[1],
  );
  if (
    /NPM_TOKEN|NODE_AUTH_TOKEN|--provenance/u.test(text) ||
    secrets.some((name) => name !== 'GITHUB_TOKEN')
  ) {
    throw new Error(
      'Release workflow must use OIDC without an npm authentication token',
    );
  }
  const workflow = record(parse(text));
  const triggers = record(workflow.on);
  const push = record(triggers.push);
  if (
    Object.keys(triggers).length !== 1 ||
    JSON.stringify(push) !== JSON.stringify({ branches: ['main'] })
  ) {
    throw new Error('Release workflow must run only on push to main');
  }
  const jobs = record(workflow.jobs);
  if (Object.keys(jobs).length !== 1 || !('release' in jobs)) {
    throw new Error('Release workflow must contain only the release job');
  }
  const job = record(jobs.release);
  if (job.if !== "github.repository == 'mike-north/sh-codemod'") {
    throw new Error('Release job must be restricted to mike-north/sh-codemod');
  }
  if (job['runs-on'] !== 'ubuntu-latest') {
    throw new Error('Release requires a hosted runner');
  }
  const permissions = {
    contents: 'write',
    'pull-requests': 'write',
    'id-token': 'write',
  };
  if (
    JSON.stringify(workflow.permissions) !== JSON.stringify(permissions) ||
    job.permissions !== undefined
  ) {
    throw new Error(
      'Workflow permissions must be exactly contents, pull-requests and id-token write',
    );
  }
  if (job.environment !== publisher.environment) {
    throw new Error(`Publishing environment must be ${publisher.environment}`);
  }
  if (!Array.isArray(job.steps)) {
    throw new Error('Missing release steps');
  }
  const steps: unknown[] = job.steps;
  let versionPullRequests = false;
  for (const entry of steps) {
    const step = record(entry);
    if (typeof step.uses !== 'string') {
      continue;
    }
    if (
      step.uses.startsWith('actions/checkout@') &&
      record(step.with)['persist-credentials'] !== false
    ) {
      throw new Error('Checkout credentials must not persist');
    }
    if (step.uses.startsWith('changesets/action@')) {
      const inputs = record(step.with);
      versionPullRequests =
        inputs.version === 'pnpm version:packages' &&
        inputs.publish === 'pnpm release';
    }
  }
  if (!versionPullRequests) {
    throw new Error(
      'Release must run the Changesets action with pnpm version:packages and pnpm release',
    );
  }
}

/**
 * Native npm performs publication and OIDC exchange; its documented CLI floor
 * applies independently of pnpm, which installs and supplies planning transport.
 * Runtime compatibility never establishes a working external trust registration.
 * @internal
 */
export function checkRuntime(): void {
  if (process.versions.node.split('.')[0] !== '24') {
    throw new Error('Trusted publishing requires Node 24');
  }
  const result = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `Cannot identify native npm client: ${result.error.message}`,
    );
  }
  const version = result.stdout.trim();
  const [major, minor, patch] = version.split('.').map(Number);
  if (
    result.status !== 0 ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    major < 11 ||
    (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))
  ) {
    throw new Error('Native npm OIDC requires npm >=11.5.1');
  }
}

/**
 * Publication is authorized only for a push to main of the registered repository inside the
 * workflow's OIDC environment, with no token fallback that could bypass trusted publishing.
 * Merging the Version Packages pull request is the owner's act; the pusher is not checked.
 * @internal
 */
export function assertReleaseAuthority(): void {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'push' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_REPOSITORY !==
      `${publisher.owner}/${publisher.repository}` ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    // Native npm must have no environment-supplied token fallback if OIDC fails.
    process.env.NPM_TOKEN !== undefined ||
    process.env.NODE_AUTH_TOKEN !== undefined ||
    Object.keys(process.env).some(
      (key) =>
        /^npm_config_/iu.test(key) &&
        /auth|token|password|username/iu.test(key),
    )
  ) {
    throw new Error(
      'Publication requires a push to main of mike-north/sh-codemod in the release workflow and its OIDC environment',
    );
  }
}

// Importing the shared trust contract never starts a check or a service request.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (
      process.argv.length !== 3 ||
      (mode !== 'check' && mode !== 'runtime' && mode !== 'guard')
    ) {
      throw new Error('Expected publishing mode: check, runtime, or guard');
    }
    // Reject before any workflow read or registry command.
    if (mode === 'guard') {
      assertReleaseAuthority();
    }
    await checkWorkflow(process.cwd());
    if (mode === 'check') {
      console.log('Release workflow checked; no service calls made.');
    } else {
      checkRuntime();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
