const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('../server/vector/indexer');

test('paragraph-aware chunks carry stable ranges and revision hashes', () => {
  const paragraphs = Array.from({ length: 9 }, (_, index) =>
    `第${index + 1}段：` + '星海'.repeat(40)
  );
  const content = paragraphs.join('\n\n');
  const chunks = chunkText(content);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length > 30);
    assert.ok(chunk.paragraphEnd >= chunk.paragraphStart);
    assert.ok(chunk.charEnd > chunk.charStart);
    assert.match(chunk.contentHash, /^[a-f0-9]{64}$/);
    assert.match(chunk.sourceRevisionHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(chunks.map(chunk => chunk.sourceRevisionHash)).size, 1);
});
