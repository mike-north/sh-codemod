/**
 * Every branch push and PR runs the standalone gates with read-only authority; tag pushes do not.
 * The workflow uses YAML's JSON subset so Node can inspect it without a YAML dependency.
 * @see https://yaml.org/spec/1.2.2/ — JSON compatibility
 * @see https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushbranchestagsbranches-ignoretags-ignore — branch and tag filters
 */
import assert from 'node:assert/strict';
import { record } from './assertions.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Only execution-relevant workflow fields participate in the delivery contract. */
interface IStep {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly run?: string;
  readonly if?: unknown;
  readonly 'continue-on-error'?: unknown;
}

/** The single validation job has no conditional or elevated permission boundary. */
interface IWorkflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly 'runs-on': string;
        readonly if?: unknown;
        readonly permissions?: unknown;
        readonly 'continue-on-error'?: unknown;
        readonly steps: readonly IStep[];
      }
    >
  >;
}

/** Structural validation establishes the workflow shape before behavioral assertions use it. */
function assertWorkflow(value: unknown): asserts value is IWorkflow {
  const input = record(value);
  record(input.on);
  record(input.permissions);
  for (const candidate of Object.values(record(input.jobs))) {
    const job = record(candidate);
    assert.equal(typeof job['runs-on'], 'string');
    assert.ok(Array.isArray(job.steps));
    for (const candidateStep of job.steps) {
      const step = record(candidateStep);
      for (const key of ['uses', 'run']) {
        assert.ok(step[key] === undefined || typeof step[key] === 'string');
      }
      if (step.with !== undefined) {
        record(step.with);
      }
    }
  }
}

/** Read the actual checked-in workflow; absence and invalid configuration must fail the test. */
function workflow(): IWorkflow {
  const source = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const value: unknown = JSON.parse(source.replace(/^#.*$/gmu, ''));
  assertWorkflow(value);
  return value;
}

/** Enforce events, authority and setup before any gate command can be executed. */
function gateCommands(config: IWorkflow): readonly string[] {
  expect(Object.keys(config.on).sort()).toEqual(['pull_request', 'push']);
  expect(config.on.push).toEqual({ branches: ['**'] });
  expect(config.on.pull_request).toBeNull();
  expect(config.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(config.jobs)).toEqual(['validation']);
  const job = Object.values(config.jobs)[0];
  if (!job) {
    throw new Error('A hosted validation job is required');
  }
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job.if).toBeUndefined();
  expect(job.permissions).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  for (const step of job.steps) {
    expect(step.if).toBe(
      step.run !== undefined &&
        /pnpm (?:check:changesets|check:versions|test:ecosystem-map)$/u.test(
          step.run,
        )
        ? '${{ !cancelled() }}'
        : undefined,
    );
    expect(step['continue-on-error']).toBeUndefined();
  }
  const actions = job.steps.filter((step) => step.uses !== undefined);
  expect(actions.map((step) => step.uses?.split('@')[0])).toEqual([
    'actions/checkout',
    'actions/setup-node',
    'pnpm/action-setup',
  ]);
  expect(actions[0]?.with?.['persist-credentials']).toBe(false);
  expect(String(actions[1]?.with?.['node-version'])).toBe('24.14.0');
  expect(actions[2]?.uses).toBe(
    'pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115',
  );
  const manifest = record(
    JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ),
  );
  assert.equal(typeof manifest.packageManager, 'string');
  if (typeof manifest.packageManager !== 'string') {
    throw new Error('Missing native pnpm identity');
  }
  expect(manifest.packageManager).toBe('pnpm@12.16.1');
  // Omitted version delegates to packageManager; an explicit override must match it exactly.
  expect(
    actions[2]?.with?.version ?? manifest.packageManager.split('@')[1],
  ).toBe('12.16.1');
  expect(actions[2]?.with?.run_install).toBe(false);
  expect(job.steps.slice(0, 3)).toEqual(actions);
  const commands = job.steps.flatMap((step) =>
    step.run === undefined ? [] : [step.run],
  );
  expect(commands).toEqual(
    [
      'install --frozen-lockfile',
      'check:changesets',
      'check:versions',
      'test:ecosystem-map',
      'build',
      'check',
      'test',
    ].map((command) => `env -u NO_COLOR nice pnpm ${command}`),
  );
  // Limit this job to local validation; no setup, trust, release or publication command belongs here.
  for (const command of commands) {
    expect(command).toMatch(
      /^env -u NO_COLOR nice pnpm (?:install --frozen-lockfile|check:changesets|check:versions|test:ecosystem-map|build|check|test)$/u,
    );
  }
  return commands;
}

/** Execute the workflow's shell commands with a recording pnpm, including real exit propagation. */
function runGates(
  config: IWorkflow,
  failGate = '',
): { readonly status: number | null; readonly calls: readonly string[] } {
  gateCommands(config);
  const steps = Object.values(config.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.run !== undefined);
  const directory = mkdtempSync(join(tmpdir(), 'sh-codemod-ci-'));
  const log = join(directory, 'calls');
  try {
    writeFileSync(log, '');
    writeFileSync(
      join(directory, 'pnpm'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CI_GATE_LOG"\nif [ "$1" = "$CI_FAIL_GATE" ]; then exit 37; fi\n',
      { mode: 0o755 },
    );
    let status: number | null = 0;
    for (const step of steps) {
      if (status !== 0 && step.if !== '${{ !cancelled() }}') {
        continue;
      }
      const command = step.run;
      if (command === undefined) {
        throw new Error('Missing shell command');
      }
      const result = spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', command],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            CI_GATE_LOG: log,
            CI_FAIL_GATE: failGate,
          },
        },
      );
      if (result.error) {
        throw result.error;
      }
      if (status === 0) {
        status = result.status;
      }
    }
    return { status, calls: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('standalone CI delivery', () => {
  it('runs frozen install, build, check and test on every branch push and PR, excluding tag pushes', () => {
    expect(runGates(workflow())).toEqual({
      status: 0,
      calls: [
        'install --frozen-lockfile',
        'check:changesets',
        'check:versions',
        'test:ecosystem-map',
        'build',
        'check',
        'test',
      ],
    });
  });

  it.each([
    'install',
    'check:changesets',
    'check:versions',
    'test:ecosystem-map',
    'build',
    'check',
    'test',
  ])('refuses success after a failing %s gate', (gate) => {
    const result = runGates(workflow(), gate);
    expect(result.status).toBe(37);
    const policy = ['check:changesets', 'check:versions', 'test:ecosystem-map'];
    const ordinary = ['build', 'check', 'test'];
    const prefix = ['install --frozen-lockfile', ...policy];
    expect(result.calls).toEqual(
      gate === 'install' || policy.includes(gate)
        ? prefix
        : [...prefix, ...ordinary.slice(0, ordinary.indexOf(gate) + 1)],
    );
  });

  it('rejects incorrect triggers and missing or bypassed gates', () => {
    const original = workflow();
    expect(() => gateCommands({ ...original, on: { push: null } })).toThrow();
    expect(() =>
      gateCommands({
        ...original,
        on: { ...original.on, push: null },
      }),
    ).toThrow();
    expect(() =>
      gateCommands({
        ...original,
        on: { ...original.on, push: { branches: ['main'] } },
      }),
    ).toThrow();
    const job = Object.values(original.jobs)[0];
    if (!job) {
      throw new Error('The real validation job is required');
    }
    expect(() =>
      gateCommands({ ...original, jobs: { renamed: job } }),
    ).toThrow();
    expect(() =>
      gateCommands({
        ...original,
        jobs: {
          validation: {
            ...job,
            steps: job.steps.filter(
              (step) => !step.run?.endsWith('pnpm check'),
            ),
          },
        },
      }),
    ).toThrow();
    expect(() =>
      gateCommands({
        ...original,
        jobs: { validation: { ...job, if: 'false' } },
      }),
    ).toThrow();
    expect(() =>
      gateCommands({
        ...original,
        jobs: {
          validation: {
            ...job,
            steps: job.steps.map((step) =>
              step.run ? { ...step, 'continue-on-error': true } : step,
            ),
          },
        },
      }),
    ).toThrow();
  });
});
