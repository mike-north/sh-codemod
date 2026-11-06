/**
 * Validates project-owned grammar and filename options before any parse.
 * The boundary rejects removed upstream spellings instead of ignoring them;
 * source syntax diagnostics and resource refusals remain parser responsibilities.
 */
import type { ParseOptions } from 'sh-ast';
import { configurationMessage } from './configuration-message.js';
import { isShellDialect, SHELL_VARIANTS, SUPPORTED_SHELL_DIALECTS } from './shell-dialect.js';
import type { ShellDialect } from './shell-dialect.js';

/** Grammar and diagnostic source name shared by non-lint services. @internal */
export interface IServiceOptions {
  /** Bash when absent; null and other invalid values never select the default. */
  readonly dialect?: ShellDialect;
  /** Source name for diagnostics; never a filesystem read or printer output. */
  readonly filename?: string;
}

/** Validate project vocabulary, including the presence of removed keys with undefined values. @internal */
export function serviceParseOptions(
  service: 'format' | 'createEditor',
  options: IServiceOptions,
): ParseOptions {
  const input: Record<string, unknown> = options as Record<string, unknown>;
  /** ESLINT_SH_SERVICE_OPTION means a project binding cannot be honored, before parsing source. */
  function invalid(key: string, detail: string): never {
    throw Object.assign(
      new TypeError(configurationMessage(`${service} options.${key}`, detail, input[key])),
      {
        code: 'ESLINT_SH_SERVICE_OPTION',
      },
    );
  }
  for (const removed of ['Variant', 'Filename']) {
    if (removed in input)
      invalid(removed, 'is not supported; use project dialect/filename options');
  }
  if (service === 'createEditor') {
    for (const key of Object.keys(input)) {
      if (key !== 'dialect' && key !== 'filename') {
        invalid(key, 'is not a supported editor option');
      }
    }
  }
  const { dialect, filename } = input;
  if (dialect !== undefined && !isShellDialect(dialect)) {
    invalid('dialect', `must be one of ${SUPPORTED_SHELL_DIALECTS.join(', ')}`);
  }
  if (filename !== undefined && typeof filename !== 'string') {
    invalid('filename', 'must be a string');
  }
  return {
    Variant: SHELL_VARIANTS[dialect ?? 'bash'],
    ...(filename === undefined ? {} : { Filename: filename }),
    KeepComments: true,
  };
}
