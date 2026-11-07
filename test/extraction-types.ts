/** Compile-time public contract: grammar identity belongs exclusively to sh-ast. */
import { expectTypeOf } from 'vitest';
import { LangPOSIX } from 'sh-ast';
import type { LangVariant as ProducerVariant } from 'sh-ast';
import { format, createEditor } from '../src/index.js';
import type {
  LangVariant,
  FormatOptions,
  EditorOptions,
} from '../src/index.js';
expectTypeOf<LangVariant>().toEqualTypeOf<ProducerVariant>();
expectTypeOf<FormatOptions['dialect']>().toEqualTypeOf<
  ProducerVariant | undefined
>();
expectTypeOf<EditorOptions['dialect']>().toEqualTypeOf<
  ProducerVariant | undefined
>();
format('echo hi', { dialect: LangPOSIX });
createEditor('echo hi', { dialect: 0 });
// @ts-expect-error grammar labels were deliberately removed from the public contract
format('echo hi', { dialect: 'posix' });
// @ts-expect-error arbitrary numbers are not members of the producer language type
createEditor('echo hi', { dialect: 999 });
