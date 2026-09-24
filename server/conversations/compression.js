// S3-04 / 任务书 04：两个空间各自压缩、恢复与会话重开。
//   compressConversation 只改变本会话的组装方式（covered 行 compressed=1 + 存档摘要行
//   + conversation_summaries 版本记录），绝不删除原消息；恢复复位标记并删存档行，
//   摘要标记 superseded。预算保留区逻辑与写作页 compactBook 同源（保尾），摘要提示词
//   全仓唯一（四节结构，未采纳设想不得写成事实）。工具成功依据始终来自 tools_json 的
//   服务端事件记录，不来自摘要自述。
const db = require('../db');
const { callLLMFull } = require('../llm');
const svc = require('./service');
const runSvc = require('../runtime/run-service');

// 压缩转录纯函数与压缩率（自 routes/chat.js 上收，全仓唯一实现；chat.js 反向引用，
// 避免「压缩估算与实际发送两份口径」——A-13 原则在压缩链的延续）。
// 单条裁 500 字 + 整体限额内「保尾」：toCompress 按时间正序，归档块里最新的是与
// 保留区衔接的上下文，摘要输入必须保住尾部。
function buildCompressTranscript(messages, { perMessage = 500, total = 12000 } = {}) {
  const transcript = (messages || [])
    .map(m => (m.role === 'user' ? '作者：' : 'AI：')
      + (m.content.length > perMessage ? m.content.slice(0, perMessage) + '…' : m.content))
    .join('\n');
  return transcript.length > total ? transcript.slice(transcript.length - total) : transcript;
}

function getCompressionRatio() {
  const row = db.get('SELECT value FROM settings WHERE key = ?', ['compression_ratio']);
  const n = Number(row && row.value);
  if (!n || n < 0.5 || n > 0.95) return 0.8;
  return n;
}

// 四节摘要指令（唯一含义来源）：设想节必须显式标注非事实，防止「可能让角色离开」
// 被总结成「角色已经离开」（任务书原文反例）。
const SUMMARY_SYSTEM = `你是小说工坊的对话档案管理员。把一段创作对话压缩成存档摘要，600字以内，必须分四节输出：
【已确认的资料与设定】作者已确认的资料引用、设定与决定。
【已执行的动作与结果】已真实执行并结算的动作（以对话中的工具/确认记录为准）。
【未决问题】尚未解决、等待作者决定的问题。
【作者尚未采纳的设想】仍在讨论中的想法与假设——这些不是事实，不得写成既定剧情或已发生的事。
只输出摘要正文。这份摘要会替代原对话进入后续上下文，必须保住对后续工作有用的信息。`;

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// 保留区：从最新往回累计 tokens（chars/4 与 contextBudget.estimateText 同口径），
// 界内保留——当前用户请求与正在结算的工具配对永远在保留区内（任务书预算要求）。
function keepBoundary(active, targetTokens) {
  const { estimateText } = require('../contextBudget');
  let acc = 0;
  let keepCount = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    acc += estimateText(active[i].content);
    if (acc > targetTokens) break;
    keepCount++;
  }
  return keepCount;
}

async function compressConversation({ conversationId, expectedLastMessageId, targetTokens, signal = null, excludeRunId = null }) {
  const conv = svc.getConversation(conversationId);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  if (conv.status !== 'active') throw fail(409, 'CONVERSATION_ARCHIVED', '会话已归档，不能压缩');
  // 正在进行的运行（含待确认）不得压缩——不能把进行中的工具调用与其结果拆成半个对话。
  // R1 / G6 审计 P2-1：awaiting_confirmation 只在它自己发起的确认卡仍未结算时才算活跃
  // （契约 3.1：结算后转 paused）——卡已全部结算的存量滞留行不再永久阻塞压缩。
  // excludeRunId：流末自动压缩场景，发起压缩的运行就是当前运行自身（消息不会再变），豁免。
  const activeRun = runSvc.findActiveRun(conversationId, { excludeRunId });
  if (activeRun) throw fail(409, 'CONVERSATION_ACTIVE_RUN', '会话存在活跃运行，压缩须等运行结束');
  const active = db.all(
    'SELECT id, role, content, tools_json FROM messages WHERE conversation_id = ? AND COALESCE(compressed,0) != 1 ORDER BY id ASC',
    [conversationId]
  );
  if (!active.length) throw fail(400, 'NOTHING_TO_COMPRESS', '会话没有活跃消息，无需压缩');
  // 源版本乐观锁：expectedLastMessageId 与当前最大消息 id 不符 = 压缩期间有新消息 → 拒绝
  if (expectedLastMessageId !== undefined && expectedLastMessageId !== null) {
    const currentLast = active[active.length - 1].id;
    if (Number(expectedLastMessageId) !== Number(currentLast)) {
      throw fail(409, 'SOURCE_CHANGED', '会话在压缩请求后出现了新消息，请重试');
    }
  }
  const { resolveContextWindow, llmConfig } = require('../llm');
  const effectiveTarget = Number(targetTokens) > 0
    ? Math.floor(Number(targetTokens))
    : Math.floor(resolveContextWindow(llmConfig().model) * getCompressionRatio());

  const keepCount = keepBoundary(active, effectiveTarget);
  const toCompress = active.slice(0, active.length - keepCount);
  if (toCompress.length < 2) {
    throw fail(400, 'NOTHING_TO_COMPRESS', '活跃对话太少或已低于预算，无需压缩');
  }

  // 摘要生成失败时直接抛出——此时尚无任何行变更（旧上下文与完整历史原样保留）
  const transcript = buildCompressTranscript(toCompress);
  const summary = await callLLMFull([
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: transcript },
  ], { maxTokens: 1200, temperature: 0.3, signal, meta: { bookId: conv.book_id, scope: 'conversation-compact' } });

  const coveredIds = toCompress.map(m => m.id);
  const crypto = require('crypto');
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ conversationId, coveredIds, transcriptLength: transcript.length }))
    .digest('hex');
  const usageEstimate = Math.ceil(transcript.length / 4);

  // 落库单事务（A12 原则：归档标记、存档行、摘要记录同生同死，不留半更新）
  const ids = coveredIds;
  const placeholders = ids.map(() => '?').join(',');
  const summaryId = db.transaction(() => {
    db.run(`UPDATE messages SET compressed = 1 WHERE conversation_id = ? AND id IN (${placeholders})`,
      [conversationId, ...ids]);
    db.run(
      `INSERT INTO messages (book_id, conversation_id, role, content, reasoning, compressed, source, created_at)
       VALUES (?, ?, 'assistant', ?, '', 2, 'system', datetime('now','localtime'))`,
      [conv.book_id, conversationId, '【上下文压缩存档】\n' + summary.content.trim()]
    );
    const r = db.run(
      `INSERT INTO conversation_summaries (conversation_id, content, covered_message_ids, source_fingerprint, usage_estimate, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [conversationId, summary.content.trim(), JSON.stringify(coveredIds), fingerprint, usageEstimate]
    );
    return r.lastInsertRowid;
  });
  return { summaryId, coveredMessageIds: coveredIds, sourceFingerprint: fingerprint, usageEstimate, summary: summary.content.trim() };
}

function restoreConversation(conversationId) {
  const conv = svc.getConversation(conversationId);
  if (!conv) throw fail(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  const archived = db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND compressed = 1', [conversationId]);
  db.transaction(() => {
    db.run('DELETE FROM messages WHERE conversation_id = ? AND compressed = 2', [conversationId]);
    db.run('UPDATE messages SET compressed = 0 WHERE conversation_id = ? AND compressed = 1', [conversationId]);
    db.run("UPDATE conversation_summaries SET status = 'superseded' WHERE conversation_id = ? AND status = 'active'", [conversationId]);
  });
  return { conversationId, restored: (archived && archived.n) || 0 };
}

module.exports = { compressConversation, restoreConversation, buildCompressTranscript, getCompressionRatio, SUMMARY_SYSTEM };
