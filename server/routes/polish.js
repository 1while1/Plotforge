const express = require('express');
const router = express.Router({ mergeParams: true });

const db = require('../db');
const { callLLM } = require('../llm');

function buildSystemPrompt(requirement) {
  let system = '你是中文网络小说的文字润色编辑。润色给定的小说文字，要求：1. 严格保持原有剧情、人物、设定、对话含义不变；2. 只优化文字表达：句式节奏、画面感、用词精准度、删减冗余；3. 保持原文篇幅大致相当（浮动不超过20%）；4. 只输出润色后的正文，不要任何解释。';
  const reqText = (requirement || '').trim();
  if (reqText) {
    system += '作者的润色要求：' + reqText;
  }
  return system;
}

router.post('/:bookId/chapters/:id/polish', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const { id: chapterId } = req.params;
    const { requirement, scope, selected_text } = req.body || {};

    const actualScope = scope || 'chapter';

    const chapter = await db.get(
      'SELECT * FROM chapters WHERE id = ? AND book_id = ?',
      [chapterId, bookId]
    );

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    let original;

    if (actualScope === 'selection') {
      const selected = (selected_text || '').trim();
      if (!selected) {
        return res.status(400).json({ error: 'selected_text 不能为空' });
      }
      original = selected;
    } else {
      if (!chapter.content || !chapter.content.trim()) {
        return res.status(400).json({ error: '章节内容为空' });
      }
      original = chapter.content;
    }

    // 数据安全护栏（百万字评估 P0）：润色输入超过 6000 字符时此前只截前段发给模型，
    // 但前端「采纳」会用返回内容替换完整选区/整章——超出部分被静默删除。
    // 宁可拒绝也不静默截断：请作者分次润色或缩短选区。后续支持分段润色后再放开。
    if (original.length > 6000) {
      return res.status(400).json({
        error: `本次润色范围 ${original.length} 字，超过单次 6000 字上限。为避免采纳时静默丢失后文，已拒绝执行：请缩短选区分次润色（长章建议按场景分段）`,
      });
    }

    const systemPrompt = buildSystemPrompt(requirement);
    const polished = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: original }
      ],
      { maxTokens: 6000, temperature: 0.5, meta: { bookId, scope: 'polish' } }
    );

    db.run(
      'INSERT INTO polish_history (chapter_id, scope, original, polished, requirement) VALUES (?, ?, ?, ?, ?)',
      [chapterId, actualScope, original, polished, requirement || '']
    );

    const historyRow = db.get('SELECT last_insert_rowid() AS history_id');
    const historyId = historyRow ? historyRow.history_id : null;

    res.json({ polished, history_id: historyId });
  } catch (err) {
    next(err);
  }
});

router.get('/:bookId/chapters/:id/polish-history', async (req, res, next) => {
  try {
    const { bookId } = req.params;
    const { id: chapterId } = req.params;

    const chapter = await db.get(
      'SELECT id FROM chapters WHERE id = ? AND book_id = ?',
      [chapterId, bookId]
    );

    if (!chapter) {
      return res.status(404).json({ error: '章节不存在' });
    }

    const history = await db.all(
      'SELECT id, scope, requirement, polished, created_at FROM polish_history WHERE chapter_id = ? ORDER BY id DESC LIMIT 10',
      [chapterId]
    );

    res.json({ history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
