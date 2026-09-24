const test = require('node:test');
const assert = require('node:assert/strict');
const {
  truncateHead, truncateTail, truncateLine, truncateChars,
  truncateStringToBytesFromEnd, formatSize, byteLength,
  DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH,
} = require('../server/utils/truncate');

test('常量与 Pi 对齐', () => {
  assert.equal(DEFAULT_MAX_LINES, 2000);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024);
  assert.equal(GREP_MAX_LINE_LENGTH, 500);
});

test('truncateHead 未超限原样返回', () => {
  const r = truncateHead('a\nb\nc');
  assert.equal(r.content, 'a\nb\nc');
  assert.equal(r.truncated, false);
  assert.equal(r.truncatedBy, null);
  assert.equal(r.totalLines, 3);
});

test('truncateHead 按行数截断，从不返回半行', () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const r = truncateHead(content, { maxLines: 4, maxBytes: 1e9 });
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'lines');
  assert.equal(r.outputLines, 4);
  assert.equal(r.content, 'line0\nline1\nline2\nline3');
});

test('truncateHead 按字节截断', () => {
  const r = truncateHead('aaaa\nbbbb\ncccc', { maxLines: 100, maxBytes: 9 });
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'bytes');
  assert.equal(r.content, 'aaaa\nbbbb');
});

test('truncateHead 首行即超字节限返回空并标记', () => {
  const r = truncateHead('x'.repeat(100), { maxBytes: 10 });
  assert.equal(r.content, '');
  assert.equal(r.firstLineExceedsLimit, true);
  assert.equal(r.truncatedBy, 'bytes');
});

test('truncateTail 保留结尾行', () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const r = truncateTail(content, { maxLines: 3, maxBytes: 1e9 });
  assert.equal(r.content, 'line7\nline8\nline9');
  assert.equal(r.truncatedBy, 'lines');
});

test('truncateTail 字节限时含半行边界', () => {
  const r = truncateTail('z'.repeat(50), { maxBytes: 10 });
  assert.equal(r.lastLinePartial, true);
  assert.ok(byteLength(r.content) <= 10);
});

test('truncateLine 超长单行加标记', () => {
  const r = truncateLine('y'.repeat(600), 500);
  assert.equal(r.wasTruncated, true);
  assert.ok(r.text.endsWith('... [truncated]'));
  const short = truncateLine('ok', 500);
  assert.equal(short.wasTruncated, false);
  assert.equal(short.text, 'ok');
});

test('truncateChars 未超限原样返回', () => {
  const r = truncateChars('abc', 10);
  assert.equal(r.content, 'abc');
  assert.equal(r.truncated, false);
});

test('truncateChars 码点安全：不劈开 emoji 代理对', () => {
  const r = truncateChars('😀😁😂', 2, { suffix: '' });
  assert.equal(r.content, '😀😁');
  assert.equal(r.outputChars, 2);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.content), '不得含孤立代理项');
});

test('truncateChars 中文按码点保留并追加 suffix', () => {
  const r = truncateChars('一二三四五六', 3, { suffix: '…' });
  assert.equal(r.content, '一二三…');
  assert.equal(r.truncated, true);
  assert.equal(r.outputChars, 3);
});

test('truncateChars reserveSuffix 合计不超 maxChars', () => {
  const r = truncateChars('abcdef', 4, { suffix: '…', reserveSuffix: true });
  assert.equal(Array.from(r.content).length, 4);
  assert.equal(r.content, 'abc…');
});

test('truncateChars from=tail 保留结尾', () => {
  const r = truncateChars('abcdef', 3, { suffix: '…', from: 'tail' });
  assert.equal(r.content, '…def');
});

test('truncateStringToBytesFromEnd 落在 UTF-8 边界', () => {
  const r = truncateStringToBytesFromEnd('中文abc', 4);
  assert.ok(byteLength(r) <= 4);
  assert.ok(r.endsWith('abc'));
});

test('formatSize 人类可读', () => {
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(2048), '2.0KB');
  assert.equal(formatSize(50 * 1024), '50.0KB');
});
