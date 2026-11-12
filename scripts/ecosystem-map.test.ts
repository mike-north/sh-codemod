/** The shared responsibility contract is pinned to the canonical payload. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/** Pin the canonical bytes, independently of the repository's local copy. */
const canonicalDigest =
  'b343beb73d6d82beed7147f37c8252f98bc9bcafd7c25ec6305f0f82db7f0ca8';

/** Unique standalone fences delimit the payload without trimming its terminal newline. */
function extractMap(instructions: string): string {
  assert.equal(
    instructions.split('<!-- ecosystem-map:begin -->').length,
    2,
    'begin marker must occur exactly once',
  );
  assert.equal(
    instructions.split('<!-- ecosystem-map:end -->').length,
    2,
    'end marker must occur exactly once',
  );
  assert.ok(
    !instructions.includes('<!-- ecosystem-map:begin -->\r') &&
      !instructions.includes('<!-- ecosystem-map:end -->\r'),
    'markers require LF standalone lines',
  );
  const begins = [...instructions.matchAll(/^<!-- ecosystem-map:begin -->$/gm)];
  const ends = [...instructions.matchAll(/^<!-- ecosystem-map:end -->$/gm)];
  assert.equal(begins.length, 1, 'one standalone begin marker is required');
  assert.equal(ends.length, 1, 'one standalone end marker is required');
  const begin = begins[0];
  const end = ends[0];
  assert.ok(begin && end);
  const start = begin.index + begin[0].length + 1;
  assert.ok(end.index > start, 'the end marker must follow the payload');
  return instructions.slice(start, end.index);
}

await test('the ecosystem map matches the complete canonical bytes', async () => {
  const instructions = await readFile('AGENTS.md', 'utf8');
  const payload = extractMap(instructions);
  assert.ok(
    payload.endsWith('\n'),
    'the terminal newline belongs to the payload',
  );
  assert.equal(Buffer.byteLength(payload), 14058);
  assert.equal(
    createHash('sha256').update(payload).digest('hex'),
    canonicalDigest,
  );
});

await test('map extraction rejects missing, duplicate, inline, and reversed fences', () => {
  const begin = '<!-- ecosystem-map:begin -->';
  const end = '<!-- ecosystem-map:end -->';
  const valid = `${begin}\npayload\n${end}\n`;
  assert.equal(extractMap(valid), 'payload\n');
  for (const invalid of [
    valid.replace(begin, ''),
    valid.replace(end, ''),
    `${begin}\n${valid}`,
    `${valid}${end}\n`,
    `inline ${valid}`,
    valid.replace(end, `inline ${end}`),
    `${end}\npayload\n${begin}\n`,
  ]) {
    assert.throws(() => extractMap(invalid), { name: 'AssertionError' });
  }
});

await test('map extraction refuses marker lookalikes adjacent to an otherwise valid fence', () => {
  const valid =
    '<!-- ecosystem-map:begin -->\npayload\n<!-- ecosystem-map:end -->\n';
  for (const invalid of [
    `inline <!-- ecosystem-map:begin -->\n${valid}`,
    `${valid}inline <!-- ecosystem-map:end -->\n`,
    valid.replace('begin -->\n', 'begin -->\r\n'),
  ]) {
    assert.throws(() => extractMap(invalid));
  }
});

await test('CLAUDE delegates repository responsibilities to AGENTS', async () => {
  assert.match(
    await readFile('CLAUDE.md', 'utf8'),
    /\[AGENTS\.md\]\(AGENTS\.md\)/u,
  );
});
