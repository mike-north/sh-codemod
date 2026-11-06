/**
 * Human diagnostics for project-owned configuration boundaries. Codes belong to
 * the rejecting boundary; this module only keeps paths and received values
 * consistent, without constructing errors or coupling runtime packages.
 */

/**
 * Render a rejected value using the project's short JSON-first convention.
 * Non-JSON values must not replace the intended configuration failure with a
 * serialization exception. The rendering is diagnostic text, never stored state.
 * @internal
 */
export function describeConfigurationValue(value: unknown): string {
  // JSON turns nonfinite numbers into null, which would identify a different rejected value.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return `${String(value)}n`;
  }
  try {
    // JSON.stringify also returns undefined for functions, symbols and undefined.
    const rendered = JSON.stringify(value) as string | undefined;
    return rendered ?? String(value);
  } catch {
    return String(value);
  }
}

/** The user's path identifies the binding; prose may evolve independently of the error code. @internal */
export function configurationMessage(where: string, detail: string, value: unknown): string {
  return `${where}: ${detail}; received ${describeConfigurationValue(value)}.`;
}
