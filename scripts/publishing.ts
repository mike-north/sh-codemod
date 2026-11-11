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

/** Repository guard shared by every job so a fork can never reach the release machinery. */
const repositoryGuard = `github.repository == '${publisher.owner}/${publisher.repository}'`;

/**
 * The Changesets action release that the workflow's three sub-actions are pinned to. Every
 * third-party action is referenced by full commit SHA; this one is checked by value because the
 * sub-actions must all come from the same release for their hand-off (mode, publish output) to
 * be consistent.
 * @internal
 */
export const changesetsActionSha = 'ae32849d5ba541f9ae29e40e22a623bc13562f51';

/** Authority each job may hold; only `publish` receives OIDC, and only it may name the environment. */
const jobPermissions = {
  'select-mode': { contents: 'read' },
  version: { contents: 'write', 'pull-requests': 'write' },
  publish: { contents: 'write', 'id-token': 'write' },
} as const;

/** Steps of one job as validated records; anything else is a malformed workflow. */
function stepsOf(
  job: Record<string, unknown>,
  name: string,
): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) {
    throw new Error(`Missing steps in release job ${name}`);
  }
  const entries: unknown[] = job.steps;
  return entries.map((entry) => record(entry));
}

/** The single step of a job that runs the named Changesets sub-action, with its inputs. */
function changesetsStep(
  steps: Record<string, unknown>[],
  subAction: string,
): Record<string, unknown> {
  const matches = steps.filter(
    (step) =>
      typeof step.uses === 'string' &&
      step.uses === `changesets/action/${subAction}@${changesetsActionSha}`,
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error(
      `Release job must run changesets/action/${subAction} pinned to ${changesetsActionSha} exactly once`,
    );
  }
  return match;
}

/**
 * Validate that the release workflow keeps the identity npm trusted publishing registered
 * (repository, file name, environment) and splits authority across three jobs: `select-mode`
 * (read only), `version` (contents and pull-request write) and `publish` (contents write for
 * tags and GitHub Releases, plus OIDC), with nothing granted at the workflow level.
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
  if (JSON.stringify(workflow.permissions) !== '{}') {
    throw new Error(
      'Release workflow must grant no permissions at workflow level',
    );
  }
  const jobs = record(workflow.jobs);
  if (
    JSON.stringify(Object.keys(jobs).sort()) !==
    JSON.stringify(Object.keys(jobPermissions).sort())
  ) {
    throw new Error(
      'Release workflow must contain exactly the select-mode, version and publish jobs',
    );
  }
  const modeGuards = {
    'select-mode': repositoryGuard,
    version: "needs.select-mode.outputs.mode == 'version'",
    publish: "needs.select-mode.outputs.mode == 'publish'",
  };
  for (const name of ['select-mode', 'version', 'publish'] as const) {
    const job = record(jobs[name]);
    if (job['runs-on'] !== 'ubuntu-latest') {
      throw new Error('Release requires a hosted runner');
    }
    if (
      JSON.stringify(job.permissions) !== JSON.stringify(jobPermissions[name])
    ) {
      throw new Error(`Release job ${name} has the wrong permissions`);
    }
    if (job.if !== modeGuards[name]) {
      throw new Error(`Release job ${name} has the wrong condition`);
    }
    if (name !== 'select-mode' && job.needs !== 'select-mode') {
      throw new Error(`Release job ${name} must depend on select-mode`);
    }
    // Trusted publishing is registered against the environment of the publishing job only.
    if (
      name === 'publish'
        ? job.environment !== publisher.environment
        : job.environment !== undefined
    ) {
      throw new Error(
        `Only the publish job may, and must, use the ${publisher.environment} environment`,
      );
    }
    for (const step of stepsOf(job, name)) {
      if (typeof step.uses !== 'string') {
        continue;
      }
      if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) {
        throw new Error(
          `Action must be pinned by full commit SHA: ${step.uses}`,
        );
      }
      if (
        step.uses.startsWith('actions/checkout@') &&
        record(step.with)['persist-credentials'] !== false
      ) {
        throw new Error('Checkout credentials must not persist');
      }
    }
  }
  // Each job's Changesets sub-action takes exactly the commands this repository defines.
  changesetsStep(
    stepsOf(record(jobs['select-mode']), 'select-mode'),
    'select-mode',
  );
  const versionInputs = record(
    changesetsStep(stepsOf(record(jobs.version), 'version'), 'version').with,
  );
  if (versionInputs.script !== 'pnpm version:packages') {
    throw new Error('Version job must run pnpm version:packages');
  }
  const publishInputs = record(
    changesetsStep(stepsOf(record(jobs.publish), 'publish'), 'publish').with,
  );
  if (publishInputs.script !== 'pnpm release') {
    throw new Error('Publish job must run pnpm release');
  }
  // Pushing the tag and creating the GitHub Release are what v1 silently stopped doing.
  if (
    publishInputs['push-git-tags'] !== true ||
    publishInputs['create-github-releases'] !== true
  ) {
    throw new Error(
      'Publish job must push git tags and create GitHub Releases',
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
