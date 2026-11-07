/**
 * Validates caller-owned option names, numeric dialect shape and diagnostic filename.
 * The boundary rejects removed upstream spellings instead of ignoring them;
 * numeric Variant acceptance, syntax diagnostics and resource refusals remain parser responsibilities.
 */
import { LangBash } from 'sh-ast';
import type { LangVariant, ParseOptions } from 'sh-ast';
import { configurationMessage } from './configuration-message.js';

/** Grammar and diagnostic source name shared by non-lint services. @internal */
export interface IServiceOptions {
  /** Bash when absent; null and other invalid values never select the default. */
  readonly dialect?: LangVariant;
  /** Source name for diagnostics; never a filesystem read or printer output. */
  readonly filename?: string;
}

/** Validate caller options, including the presence of removed keys with undefined values. @internal */
export function serviceParseOptions(
  service: 'format' | 'createEditor',
  options: IServiceOptions,
): ParseOptions {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Preserve caller identity and inherited keys; dictionary values remain unknown until individually checked.
  const input: Record<string, unknown> = options as Record<string, unknown>;
  /** SH_CODEMOD_SERVICE_OPTION means a caller option cannot be honored, before parsing source. */
  function invalid(key: string, detail: string): never {
    throw Object.assign(
      new TypeError(
        configurationMessage(`${service} options.${key}`, detail, input[key]),
      ),
      {
        code: 'SH_CODEMOD_SERVICE_OPTION',
      },
    );
  }
  for (const removed of ['Variant', 'Filename']) {
    if (removed in input) {
      invalid(
        removed,
        'is not supported; use project dialect/filename options',
      );
    }
  }
  if (service === 'createEditor') {
    for (const key of Object.keys(input)) {
      if (key !== 'dialect' && key !== 'filename') {
        invalid(key, 'is not a supported editor option');
      }
    }
  }
  const { dialect, filename } = input;
  // Reject removed string labels at the caller boundary; never duplicate parser membership.
  if (dialect !== undefined && typeof dialect !== 'number') {
    invalid('dialect', 'must be a numeric sh-ast LangVariant');
  }
  if (filename !== undefined && typeof filename !== 'string') {
    invalid('filename', 'must be a string');
  }
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Preserve observations of caller-owned getters; null is rejected during validation.
    Variant: options.dialect === undefined ? LangBash : options.dialect,
    ...(filename === undefined ? {} : { Filename: filename }),
    KeepComments: true,
  };
}
