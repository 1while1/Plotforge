const version = 'volume_summary_propagation_v1';
const checksum = 'sha256:volume-summary-propagation-20260910-01';

// 卷总结底料指纹（方向报告 4.1）：「章总结变化 → 卷总结过期」的传播链此前缺失——
// 正文变化清空章总结已做，但基于旧章总结生成的卷总结不会被标记，作者无从知道
// 卷总结讲的还是旧故事。本迁移为 volumes 加两列：
//   summary_based_on：保存卷总结时卷内各章总结的联合指纹（sha256）
//   summary_stale：底料指纹变化后置 1，提示需重新生成
// （全书摘要层的传播另批评估：story_state.book_summary 有作者手写路径，过期语义需区分）
function up(db) {
  const cols = db.all("PRAGMA table_info(volumes)").map(row => row.name);
  if (!cols.includes('summary_based_on')) {
    db.exec('ALTER TABLE volumes ADD COLUMN summary_based_on TEXT');
  }
  if (!cols.includes('summary_stale')) {
    db.exec("ALTER TABLE volumes ADD COLUMN summary_stale INTEGER NOT NULL DEFAULT 0");
  }
}

module.exports = { version, checksum, up };
