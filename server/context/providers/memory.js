const { truncateChars } = require('../../utils/truncate');
const { listChapterPositions } = require('../../domain/chapterNavigation');

function bounded(text, length, tail = false) {
  return truncateChars(String(text || '').trim(), length, { suffix: '……（节选）', reserveSuffix: true, from: tail ? 'tail' : 'head' }).content;
}

function recent(items, limit, render) {
  const kept = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const line = render(items[index]);
    if (used + line.length > limit) break;
    kept.unshift(line);
    used += line.length;
  }
  return kept.join('\n');
}

module.exports = {
  name: 'memory', title: '前情记忆', priority: 40, budget: 7200,
  build({ book, chapterId, db, chapterPositions, writingTarget, narrativeScope }) {
    const parts = [];
    const positions = chapterPositions || listChapterPositions(book.id);
    const current = positions.find(chapter => chapter.id === Number(chapterId)) || positions.at(-1);
    const volumes = db.all('SELECT id, title, sort_order, summary FROM volumes WHERE book_id = ? ORDER BY sort_order, id', [book.id]);
    const currentVolume = volumes.find(volume => volume.id === current?.volume_id) || volumes.at(-1);
    const bookState = db.get("SELECT content, updated_at, stale FROM story_state WHERE book_id = ? AND kind = 'book_summary'", [book.id]);
    if (!narrativeScope?.historical && bookState?.content?.trim()) {
      parts.push('◇ 全书进展摘要' + (bookState.stale ? '（底料已变化，请以正文为准）' : '（更新于' + bookState.updated_at + '）') + '\n' + bounded(bookState.content, 800));
    }
    if (current) parts.push('◇ 当前进度（任务锚点，不代表全书最新）：第' + (current.volume_ordinal || '?') + '卷' + (current.volume ? '《' + current.volume + '》' : '') + '·第' + current.chapter_ordinal + '章《' + current.title + '》 chapterId=' + current.id);
    if (currentVolume) {
      const previousVolumes = volumes.slice(0, volumes.findIndex(volume => volume.id === currentVolume.id)).filter(volume => volume.summary?.trim());
      const rendered = recent(previousVolumes, 1300, volume => '《' + volume.title + '》：' + bounded(volume.summary, 600));
      if (rendered) parts.push('◇ 已完结分卷概要\n' + rendered);
    }
    const previous = positions.filter(chapter => !current || chapter.global_ordinal < current.global_ordinal);
    const rows = previous.slice(-8).map(position => ({ ...position, ...db.get('SELECT summary, content FROM chapters WHERE id = ? AND book_id = ?', [position.id, book.id]) }));
    const rendered = recent(rows, 1800, chapter => {
      const source = chapter.summary?.trim() ? bounded(chapter.summary, 500)
        : chapter.content?.trim() ? '（暂无摘要，正文结尾节选）' + bounded(chapter.content, 500, true) : '（空章，无正文和摘要）';
      return '第' + (chapter.volume_ordinal || '?') + '卷·第' + chapter.chapter_ordinal + '章《' + chapter.title + '》 [chapterId=' + chapter.id + ']：' + source;
    });
    if (rendered) parts.push('◇ 最近连续章节（按目录顺序，缺摘要不跳章）\n' + rendered);
    const currentRow = current && db.get('SELECT id, title, content FROM chapters WHERE id = ? AND book_id = ?', [current.id, book.id]);
    const previousContent = [...previous].reverse().find(chapter => chapter.has_content);
    const tailRow = currentRow?.content?.trim() ? currentRow : previousContent && db.get('SELECT id, title, content FROM chapters WHERE id = ? AND book_id = ?', [previousContent.id, book.id]);
    if (tailRow) parts.push('◇ ' + (tailRow.id === currentRow?.id ? '当前章节' : '上一章（当前章还没有内容）') + '《' + tailRow.title + '》已有内容（保留结尾，从此衔接） [chapterId=' + tailRow.id + ']\n' + bounded(tailRow.content, 2800, true));
    if (writingTarget?.mode === 'create') parts.push('新章尚未创建。上述正文仅为前文锚点，不是本轮写入目标。');
    return parts.length ? parts.join('\n\n') : null;
  },
};
