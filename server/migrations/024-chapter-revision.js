const version = 'chapter_revision_v1';
const checksum = 'sha256:chapter-revision-20260921-01';

// S1-02 / C04-A：章节单调版本号。updated_at 乐观锁是秒级本地时间，同一秒两次
// PUT 携带同一旧值实测双双成功（审查反例 revision_collision）。revision 是整数
// 单调计数：章节可持久化字段每次实际变化 +1，只前进不回退（版本恢复也不回退），
// 供所有编辑入口做比较交换（server/domain/chapterMutations.applyChapterMutation）。
// 存量章节一律从 1 起步；只读/相同值 no-op 不递增。
function up(db) {
  const columns = db.all('PRAGMA table_info(chapters)').map(row => row.name);
  if (!columns.includes('revision')) {
    db.run('ALTER TABLE chapters ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
}

module.exports = { version, checksum, up };
