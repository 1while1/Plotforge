// 大纲：书级总纲 + 当前卷大纲 + 本章节拍
module.exports = {
  name: 'outline',
  title: '大纲',
  priority: 30,
  budget: 3000,
  build({ book, chapterId, db }) {
    const parts = [];
    if (book.master_outline && book.master_outline.trim()) {
      parts.push('◇ 全书总纲\n' + book.master_outline.trim());
    }

    // 定位当前章节所在卷（无章节时用最新一卷）
    let volume = null;
    if (chapterId) {
      volume = db.get(
        'SELECT v.* FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.id = ? AND c.book_id = ?',
        [chapterId, book.id]
      );
    }
    if (!volume) {
      volume = db.get('SELECT * FROM volumes WHERE book_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1', [book.id]);
    }
    if (volume && volume.outline && volume.outline.trim()) {
      parts.push(`◇ 当前卷《${volume.title}》大纲\n` + volume.outline.trim());
    }

    if (chapterId) {
      const ch = db.get('SELECT title, beat FROM chapters WHERE id = ? AND book_id = ?', [chapterId, book.id]);
      if (ch && ch.beat && ch.beat.trim()) {
        parts.push(`◇ 本章《${ch.title}》节拍（本章必须完成的剧情节点）\n` + ch.beat.trim());
      }
    }

    return parts.length ? parts.join('\n\n') : null;
  },
};
