/** Formatting must refuse source it cannot preserve and identify the caller's file. */
import { describe, expect, it } from 'vitest';
import { format, FormatSyntaxError } from '../src/index.js';

describe('format content safety', () => {
  for (const character of ['\v', '\f']) {
    it(`refuses literal U+${character.charCodeAt(0).toString(16)} rather than changing its value`, () => {
      const source = `# 日本語\nprintf '%s' 'a${character}b'\n`;
      const options = { filename: '日本語.sh' };
      expect(() => format(source, options)).toThrow(FormatSyntaxError);
      try {
        format(source, options);
      } catch (error) {
        if (!(error instanceof FormatSyntaxError)) throw error;
        expect(error.message).toContain('日本語.sh:2:15:');
        expect(error).toMatchObject({
          code: 'SH_CODEMOD_FORMAT_SYNTAX',
          filename: '日本語.sh',
          offset: 20,
          byteOffset: 26,
          line: 2,
          column: 15,
        });
      }
    });
  }

  it('keeps escape spellings that the printer can preserve', () => {
    expect(format("printf '%s' '\\v\\f'\n")).toBe("printf '%s' '\\v\\f'\n");
  });

  it('preserves the project filename on syntax errors', () => {
    expect.assertions(3);
    try {
      format('if', { filename: '日本語.sh' });
    } catch (error) {
      expect(error).toBeInstanceOf(FormatSyntaxError);
      expect(error).toHaveProperty('filename', '日本語.sh');
      expect(error).toHaveProperty('message', expect.stringContaining('日本語.sh:'));
    }
  });
});
