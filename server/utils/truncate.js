// 统一截断工具（移植自 Pi coding-agent/src/core/tools/truncate.ts）
// 设计：
//  - 行/字节双限（先到先赢），UTF-8 边界安全，从不返回半行（bash 尾部边界除外）
//  - truncateHead 保头（文件读取）/ truncateTail 保尾（bash/日志看结尾与错误）/ truncateLine 单行（grep）
//  - truncateChars：码点安全的字符截断，用于中文文本段（保留既有 char 预算语义，不劈代理对/多字节）
// 统一取代此前散落在 chat.js / context 各 provider 的 4 处裸 slice。

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
const GREP_MAX_LINE_LENGTH = 500; // grep 每行最大字符

function byteLength(str) {
  return Buffer.byteLength(str, 'utf-8');
}

function splitLinesForCounting(content) {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

// 字节数转人类可读
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 保头截断：适合文件读取（看开头）。从不返回半行；首行即超字节限 → 空 + firstLineExceedsLimit
function truncateHead(content, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false,
      firstLineExceedsLimit: false, maxLines, maxBytes,
    };
  }

  const firstLineBytes = byteLength(lines[0] || '');
  if (firstLineBytes > maxBytes) {
    return {
      content: '', truncated: true, truncatedBy: 'bytes', totalLines, totalBytes,
      outputLines: 0, outputBytes: 0, lastLinePartial: false,
      firstLineExceedsLimit: true, maxLines, maxBytes,
    };
  }

  const out = [];
  let outBytes = 0;
  let truncatedBy = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const lineBytes = byteLength(lines[i]) + (i > 0 ? 1 : 0); // +1 换行
    if (outBytes + lineBytes > maxBytes) { truncatedBy = 'bytes'; break; }
    out.push(lines[i]);
    outBytes += lineBytes;
  }
  if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';
  const outputContent = out.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: out.length, outputBytes: byteLength(outputContent), lastLinePartial: false,
    firstLineExceedsLimit: false, maxLines, maxBytes,
  };
}

// 保尾截断：适合 bash/日志（看结尾与错误）。尾部边界可含半行
function truncateTail(content, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLength(content);
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false,
      firstLineExceedsLimit: false, maxLines, maxBytes,
    };
  }

  const out = [];
  let outBytes = 0;
  let truncatedBy = 'lines';
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
    const lineBytes = byteLength(lines[i]) + (out.length > 0 ? 1 : 0);
    if (outBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      if (out.length === 0) { // 一行都放不下：取该行尾部（半行边界）
        const t = truncateStringToBytesFromEnd(lines[i], maxBytes);
        out.unshift(t);
        outBytes = byteLength(t);
        lastLinePartial = true;
      }
      break;
    }
    out.unshift(lines[i]);
    outBytes += lineBytes;
  }
  if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = 'lines';
  const outputContent = out.join('\n');
  return {
    content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes,
    outputLines: out.length, outputBytes: byteLength(outputContent), lastLinePartial,
    firstLineExceedsLimit: false, maxLines, maxBytes,
  };
}

// 从尾部按字节截断，落在 UTF-8 字符边界（跳过后续续字节 0b10xxxxxx）
function truncateStringToBytesFromEnd(str, maxBytes) {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.slice(start).toString('utf-8');
}

// 单行截断（grep 匹配行）
function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

// 码点安全字符截断（中文文本段）：按码点切分，绝不劈开代理对/多字节字符
// options: { suffix='…', from='head'|'tail', reserveSuffix=false }
//  - reserveSuffix=false：保留 maxChars 个内容码点，再追加 suffix（总长 = maxChars + suffix）
//  - reserveSuffix=true ：内容 + suffix 合计不超过 maxChars（对齐旧 clip 语义）
function truncateChars(text, maxChars, options = {}) {
  const suffix = options.suffix ?? '…';
  const from = options.from ?? 'head';
  const reserveSuffix = options.reserveSuffix ?? false;
  const value = typeof text === 'string' ? text : String(text ?? '');
  const chars = Array.from(value); // 码点数组
  if (chars.length <= maxChars) {
    return { content: value, truncated: false, totalChars: chars.length, outputChars: chars.length };
  }
  const suffixChars = Array.from(suffix);
  const keep = reserveSuffix ? Math.max(0, maxChars - suffixChars.length) : maxChars;
  const kept = from === 'tail' ? chars.slice(chars.length - keep) : chars.slice(0, keep);
  const body = kept.join('');
  const content = from === 'tail' ? suffix + body : body + suffix;
  return { content, truncated: true, totalChars: chars.length, outputChars: kept.length };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  byteLength,
  formatSize,
  truncateHead,
  truncateTail,
  truncateStringToBytesFromEnd,
  truncateLine,
  truncateChars,
};
