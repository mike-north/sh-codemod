/**
 * Project shell vocabulary shared by linting and non-lint services. A label
 * selects one definite grammar; parser constants are an implementation detail.
 * This module is compiled into each consumer artifact, so shared semantics do
 * not require a runtime dependency between separately released packages.
 */
import { LangBash, LangBats, LangMirBSDKorn, LangPOSIX, LangZsh } from 'sh-ast';

/** Project names for the five supported shell grammars. @public */
export type ShellDialect = 'bash' | 'posix' | 'mksh' | 'bats' | 'zsh';

/** The single project-label translation to the pinned parser's grammar constants. @internal */
export const SHELL_VARIANTS: Readonly<Record<ShellDialect, number>> = {
  bash: LangBash,
  posix: LangPOSIX,
  mksh: LangMirBSDKorn,
  bats: LangBats,
  zsh: LangZsh,
};

/** Stable diagnostic ordering follows the canonical mapping, without another hand-maintained list. @internal */
export const SUPPORTED_SHELL_DIALECTS: readonly string[] = Object.keys(SHELL_VARIANTS);

/** Labels are own keys; object-prototype names never select a grammar. @internal */
export function isShellDialect(value: unknown): value is ShellDialect {
  return typeof value === 'string' && Object.hasOwn(SHELL_VARIANTS, value);
}
