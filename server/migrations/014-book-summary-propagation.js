const version = 'book_summary_propagation_v1';
const checksum = 'sha256:book-summary-propagation-20260910-01';

// 全书摘要底料指纹（方向报告 4.1 收尾）：卷层传播（012）已闭环「章总结变化 → 卷总结过期」，
// 全书摘要层此前缺失——story_state.book_summary 讲的还是旧故事时作者无从得知。
// 本迁移为 story_state 加两列（仅 book_summary kind 使用，characters/foreshadowing 恒为默认值）：
//   based_on：保存全书摘要时「全部卷总结 + 全部章总结」的联合指纹（sha256）
//   stale：底料指纹变化后置 1，提示需重新生成（手写/自动一视同仁——底料变了就是过期，
//          区别仅在重生成主体：作者手改或 Agent 工具）
// 写入路径共四个（本迁移时点）：PUT /ledger/progress、PUT /state、update_book_progress 工具、
// llm.js updateStoryState（后者当前无调用方，属预留路径，同样挂指纹刷新保持一致）。
function up(db) {
  const cols = db.all('PRAGMA table_info(story_state)').map(row => row.name);
  if (!cols.includes('based_on')) {
    db.exec('ALTER TABLE story_state ADD COLUMN based_on TEXT');
  }
  if (!cols.includes('stale')) {
    db.exec('ALTER TABLE story_state ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
  }
}

module.exports = { version, checksum, up };
