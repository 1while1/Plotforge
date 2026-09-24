// S5-01 / C06：派生总结的来源守卫（01-架构与接口契约 §7）。
//
//   captureSource({ bookId, kind, entityId }) → { bookId, kind, entityId, fingerprint, refs }
//   assertSourceCurrent(snapshot)             → 与读取时不一致时抛 409 SOURCE_CHANGED
//
// 约定（契约 §7）：
//  · fingerprint 只含任务实际读取的有序来源 id、输入字段内容哈希、结构位置与相关配置摘要；
//    **绝不含本次生成的输出字段**（章/卷/书总结自身）——否则保存总结会立刻自判过期。
//  · refs 记录读取时各来源 revision，用于最终提交 CAS（章走 applyChapterMutation 的
//    expected_revision；卷/全书在本模块的 assertSourceCurrent 内比对）。
//  · capture 必须在外部 await（模型生成）之前调用；assert 必须在最终同步提交事务内，
//    核验与写回之间不得再有 await——本模块全部 API 同步，供 db.transaction 回调直接使用。
//  · 指纹以完整来源列表为准（不建模生成端的保尾截断）：宁可多拒一次，不可把旧结果洗白。
const crypto = require('crypto');
const db = require('../db');
const { DomainError } = require('./errors');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

// 相关配置摘要：生成该派生结果时实际使用的提示词与输入成形规则。配置（提示词/截断口径）
// 变了，同一底料生成出的结果口径也就变了，因此进指纹；与温度等不影响来源语义的参数无关。
const CONFIG_DIGESTS = {
  chapter: sha256('chapter_summary.v1|system=你是小说编辑。为给定章节写剧情总结(150字内)|user=章节标题+章节内容(截断8000)|fields=chapter.title,chapter.content'),
  volume: sha256('volume_summary.v1|system=你是小说编辑。把一卷小说的各章总结压缩成一段卷级概要(300字内)|user=卷名+《章标题》：章总结(保尾6000)|fields=volume.title,volume.sort_order,chapter.title,chapter.summary,chapter.sort_order'),
  book: sha256('book_summary.v1|底料=全部卷总结+全部章总结(有序)|order=volume.sort_order,chapter.sort_order|fields=volume.summary,chapter.summary'),
};

const SOURCE_KINDS = new Set(Object.keys(CONFIG_DIGESTS));

function volumeSourceRows(bookId, volumeId) {
  return db.all(
    `SELECT id, title, summary, sort_order, revision
     FROM chapters
     WHERE book_id = ? AND volume_id = ? AND summary IS NOT NULL AND summary != ''
     ORDER BY sort_order, id`,
    [Number(bookId), Number(volumeId)]
  );
}

function bookSourceRows(bookId) {
  const volumes = db.all(
    "SELECT id, summary, sort_order FROM volumes WHERE book_id = ? AND summary != '' ORDER BY sort_order, id",
    [Number(bookId)]
  );
  const chapters = db.all(
    `SELECT c.id, c.summary, c.sort_order, COALESCE(v.sort_order, 2147483647) AS volume_sort_order
     FROM chapters c LEFT JOIN volumes v ON v.id = c.volume_id
     WHERE c.book_id = ? AND c.summary != ''
     ORDER BY volume_sort_order, c.sort_order, c.id`,
    [Number(bookId)]
  );
  return { volumes, chapters };
}

// 有序来源描述（fingerprint 的组成项）。导出供诊断与测试核对组成，不参与业务分支。
function sourceParts({ bookId, kind, entityId }) {
  const bid = Number(bookId);
  if (!SOURCE_KINDS.has(kind)) {
    throw new DomainError('SOURCE_KIND_UNSUPPORTED', `不支持的来源类型：${kind}`, 400, { kind });
  }
  if (kind === 'chapter') {
    const row = db.get('SELECT * FROM chapters WHERE id = ? AND book_id = ?', [Number(entityId), bid]);
    if (!row) throw new DomainError('CHAPTER_NOT_FOUND', '章节不存在', 404);
    return [
      'chapter',
      `book:${bid}`,
      `id:${row.id}`,
      `pos:volume=${row.volume_id == null ? 'none' : Number(row.volume_id)};sort=${Number(row.sort_order)}`,
      `title:${sha256(row.title)}`,
      `content:${sha256(row.content)}`,
      `config:${CONFIG_DIGESTS.chapter}`,
    ];
  }
  if (kind === 'volume') {
    const volume = db.get('SELECT * FROM volumes WHERE id = ? AND book_id = ?', [Number(entityId), bid]);
    if (!volume) throw new DomainError('VOLUME_NOT_FOUND', '分卷不存在', 404);
    return [
      'volume',
      `book:${bid}`,
      `id:${volume.id}`,
      `sort:${Number(volume.sort_order)}`,
      `title:${sha256(volume.title)}`,
      ...volumeSourceRows(bid, volume.id).map(
        row => `c${row.id}:sort=${Number(row.sort_order)};title=${sha256(row.title)};summary=${sha256(row.summary)}`
      ),
      `config:${CONFIG_DIGESTS.volume}`,
    ];
  }
  const { volumes, chapters } = bookSourceRows(bid);
  return [
    'book',
    `book:${bid}`,
    ...volumes.map(row => `v${row.id}:${sha256(row.summary)}`),
    ...chapters.map(row => `c${row.id}:${sha256(row.summary)}`),
    `config:${CONFIG_DIGESTS.book}`,
  ];
}

// refs：读取时各来源的 revision（仅收录确有 revision 列的来源实体；卷/全书自身无该列，
// 其有效性由 fingerprint 覆盖）。用于最终提交前的 CAS 比对。
function sourceRefs({ bookId, kind, entityId }) {
  if (kind === 'chapter') {
    const row = db.get('SELECT id, revision FROM chapters WHERE id = ? AND book_id = ?', [Number(entityId), Number(bookId)]);
    return row ? [{ kind: 'chapter', id: Number(row.id), revision: Number(row.revision) }] : [];
  }
  if (kind === 'volume') {
    return volumeSourceRows(bookId, entityId).map(row => ({ kind: 'chapter', id: Number(row.id), revision: Number(row.revision) }));
  }
  return bookSourceRows(bookId).chapters.map(row => ({ kind: 'chapter', id: Number(row.id), revision: null }));
}

// 读取时快照：必须在 await 模型之前调用（capture 在 await 前）。
function captureSource({ bookId, kind, entityId }) {
  const parts = sourceParts({ bookId, kind, entityId });
  return {
    bookId: Number(bookId),
    kind,
    entityId: Number(entityId),
    fingerprint: `sha256:${sha256(parts.join('\n'))}`,
    refs: sourceRefs({ bookId, kind, entityId }),
  };
}

// 当下 revision：来源实体已被删除按「已变化」处理（null 不等于任何读取值）。
function refRevision(ref) {
  if (ref.kind === 'chapter') {
    const row = db.get('SELECT revision FROM chapters WHERE id = ?', [Number(ref.id)]);
    return row ? Number(row.revision) : null;
  }
  return null;
}

// 最终同步提交事务内调用：来源与读取时不一致（指纹变化或来源 revision 前进）→ 409 SOURCE_CHANGED。
// 返回值是当下的快照（调用方可据此记录 sourceFingerprint）。
function assertSourceCurrent(snapshot) {
  if (!snapshot || !snapshot.fingerprint || !snapshot.kind || snapshot.entityId == null || snapshot.bookId == null) {
    throw new DomainError('SOURCE_SNAPSHOT_INVALID', '缺少来源快照：派生结果提交前必须先在生成前捕获来源', 500);
  }
  const current = captureSource({
    bookId: snapshot.bookId,
    kind: snapshot.kind,
    entityId: snapshot.entityId,
  });
  const refs = Array.isArray(snapshot.refs) ? snapshot.refs : [];
  const staleRef = refs
    .filter(ref => ref && ref.revision != null)
    .find(ref => refRevision(ref) !== Number(ref.revision));
  const fingerprintChanged = current.fingerprint !== snapshot.fingerprint;
  if (fingerprintChanged || staleRef) {
    throw new DomainError(
      'SOURCE_CHANGED',
      '来源在生成期间已变化：本次派生结果被拒收（旧结果不写入，请基于当前来源重新生成）',
      409,
      {
        kind: snapshot.kind,
        entityId: snapshot.entityId,
        reason: fingerprintChanged ? 'fingerprint' : 'revision',
        sourceFingerprint: snapshot.fingerprint,
        currentSourceFingerprint: current.fingerprint,
        ...(staleRef ? { staleRef: { kind: staleRef.kind, id: staleRef.id, revision: staleRef.revision } } : {}),
      }
    );
  }
  return current;
}

module.exports = {
  captureSource,
  assertSourceCurrent,
  sourceParts,
  CONFIG_DIGESTS,
};
