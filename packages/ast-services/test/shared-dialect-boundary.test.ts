/** Shared dialect artifacts must be self-contained, acyclic and safe to release. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Repository evidence is anchored to this test, independent of the caller's shell cwd. */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Only consumer runtime edges affect publication and cycles; development tools do not. */
interface IManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** Check the real workspace runtime graph, allowing future public packages without an exception list. */
function runtimeViolations(manifests: readonly IManifest[]): string[] {
  const packages = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const violations: string[] = [];
  /** Follow workspace runtime edges only; dependencies outside the workspace cannot form a workspace cycle. */
  function visit(manifest: IManifest, ancestors: ReadonlySet<string>): void {
    if (ancestors.has(manifest.name)) {
      violations.push(`cycle: ${[...ancestors, manifest.name].join(' -> ')}`);
      return;
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = packages.get(name);
        if (dependency === undefined) continue;
        if (manifest.private !== true && dependency.private === true) {
          violations.push(`unpublished: ${manifest.name} -> ${name}`);
        }
        visit(dependency, new Set([...ancestors, manifest.name]));
      }
    }
  }
  for (const manifest of manifests) visit(manifest, new Set());
  return violations;
}

describe('shared dialect package boundary', () => {
  it('compiles the one maintained module into both packages without an unpublished runtime edge or cycle', () => {
    const shared = read('../../../shared/shell-dialect.ts');
    expect(read('../src/shell-dialect.ts')).toBe(
      `// Generated from shared/shell-dialect.ts; edit the canonical source.\n${shared}`,
    );
    expect(read('../../eslint-plugin/src/shell-dialect.ts')).toBe(
      `// Generated from shared/shell-dialect.ts; edit the canonical source.\n${shared}`,
    );
    const services = JSON.parse(read('../package.json')) as IManifest;
    const plugin = JSON.parse(read('../../eslint-plugin/package.json')) as IManifest;
    const umbrella = JSON.parse(read('../../eslint-sh/package.json')) as IManifest;
    expect(Object.keys(services.dependencies ?? {})).toEqual(['sh-ast']);
    expect(runtimeViolations([services, plugin, umbrella])).toEqual([]);
    expect(shared).not.toMatch(/from ['"](?:eslint|@eslint|@eslint-sh)/u);
  });

  it('detects an unpublished consumer dependency and a workspace cycle', () => {
    const violations = runtimeViolations([
      { name: 'plugin', dependencies: { services: '*' } },
      { name: 'services', private: true, dependencies: { plugin: '*' } },
    ]);
    expect(violations).toContain('unpublished: plugin -> services');
    expect(violations).toContain('cycle: plugin -> services -> plugin');
  });
});
