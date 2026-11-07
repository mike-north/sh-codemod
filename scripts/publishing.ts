/**
 * Release infrastructure only: validate the OIDC workflow and enumerate actual
 * publishable packages. No product assessment or readiness state is involved.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackages, type Package } from '@manypkg/get-packages';
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

/** Only publication routing knobs may survive packing; credentials, registry overrides and provenance are outside this private repository's authority. @internal */
export function publicationConfig(value: unknown): Record<string, unknown> {
  const config = value === undefined ? {} : record(value);
  if (
    Object.keys(config).some(
      (key) => !['access', 'tag', 'directory'].includes(key),
    )
  ) {
    throw new Error('Unexpected publication configuration');
  }
  const directory = config.directory;
  if (
    directory !== undefined &&
    (typeof directory !== 'string' ||
      isAbsolute(directory) ||
      directory.split(/[\\/]/u).includes('..'))
  ) {
    throw new Error(
      'Publication artifact directory must stay within its source package',
    );
  }
  return config;
}

/** Validate dispatch-only authority before any release client can contact a service. @internal */
export async function checkWorkflow(root: string): Promise<void> {
  const text = await readFile(
    join(root, '.github/workflows', publisher.workflow),
    'utf8',
  );
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|--provenance/u.test(text)) {
    throw new Error(
      'Release workflow must use OIDC without an npm authentication token',
    );
  }
  const workflow = record(parse(text));
  const triggers = record(workflow.on);
  if (
    Object.keys(triggers).length !== 1 ||
    !('workflow_dispatch' in triggers)
  ) {
    throw new Error(
      'Release workflow must run only by owner workflow_dispatch',
    );
  }
  const jobs = record(workflow.jobs);
  if (Object.keys(jobs).length !== 1 || !('publish' in jobs)) {
    throw new Error(
      'Release workflow must contain only the owner-dispatched publish job',
    );
  }
  const job = record(jobs.publish);
  const expectedGuard =
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'mike-north/sh-codemod' && github.actor == 'mike-north'";
  if (job.if !== expectedGuard) {
    throw new Error(
      'Release job must require the exact owner-dispatch conjunction',
    );
  }
  if (job['runs-on'] !== 'ubuntu-latest') {
    throw new Error('Release requires a hosted runner');
  }
  if (
    JSON.stringify(workflow.permissions) !==
    JSON.stringify({ contents: 'read' })
  ) {
    throw new Error('Workflow must have contents read only');
  }
  if (!Array.isArray(job.steps)) {
    throw new Error('Missing release steps');
  }
  for (const entry of job.steps) {
    const step = record(entry);
    if (
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/checkout@') &&
      record(step.with)['persist-credentials'] !== false
    ) {
      throw new Error('Checkout credentials must not persist');
    }
  }
  const publish = record(jobs.publish);
  if (publish.environment !== publisher.environment) {
    throw new Error(`Publishing environment must be ${publisher.environment}`);
  }
  if (
    Object.keys(record(publish.permissions)).length !== 2 ||
    record(publish.permissions)['id-token'] !== 'write' ||
    record(publish.permissions).contents !== 'read'
  ) {
    throw new Error('Publishing requires id-token: write');
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

/** Planning and publication share the same owner-controlled workflow boundary. @internal */
export function assertOwnerDispatch(): void {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_REPOSITORY !==
      `${publisher.owner}/${publisher.repository}` ||
    process.env.GITHUB_ACTOR !== publisher.owner ||
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
      'Publication and registry planning require the owner-dispatched main workflow and its OIDC environment',
    );
  }
}

/** Public source inventory includes the singleton root exactly once; complete planned-release stability is checked separately. @internal */
export async function publicPackages(root: string): Promise<Package[]> {
  const workspace = await getPackages(root);
  const packages = [
    ...(workspace.rootPackage ? [workspace.rootPackage] : []),
    ...workspace.packages,
  ];
  const publicSources = [
    ...new Map(packages.map((pkg) => [pkg.dir, pkg])).values(),
  ].filter((pkg) => !pkg.packageJson.private);
  for (const pkg of publicSources) {
    publicationConfig(pkg.packageJson.publishConfig);
  }
  return publicSources;
}

// Importing the shared trust contract never starts a plan or service request.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (
      process.argv.length !== 3 ||
      (mode !== 'check' && mode !== 'runtime' && mode !== 'plan')
    ) {
      throw new Error('Expected publishing mode: check, runtime, or plan');
    }
    // Reject before workflow/source reads or any client/registry command.
    if (mode === 'plan') {
      assertOwnerDispatch();
    }
    await checkWorkflow(process.cwd());
    if (mode === 'runtime') {
      checkRuntime();
    } else if (mode === 'check') {
      console.log(
        'Owner-dispatched trusted-publishing workflow checked; no service calls made.',
      );
    } else {
      checkRuntime();
      await publicPackages(process.cwd());
      // Changesets owns registry-aware selection and dependency chunk ordering.
      // Its publish dispatcher is deliberately unused: native npm alone publishes.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve('@changesets/cli/bin.js')),
          'publish-plan',
          '--output',
          '.tmp/publish-plan.json',
        ],
        { stdio: 'inherit' },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error('Changesets publish planning failed');
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
