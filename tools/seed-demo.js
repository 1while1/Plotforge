// 播种示例作品：把 tools/demo/demo-books.json 写进数据库，便于首次启动即可体验各工作台。
// 用法：node tools/seed-demo.js          （写入 data/novel.db）
//       NOVEL_DB_FILE=/tmp/x.db node tools/seed-demo.js   （写入指定库）
// 幂等：同名书籍已存在则跳过，可重复执行。
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

const DEMO_FILE = path.join(__dirname, 'demo', 'demo-books.json');

async function main() {
  const payload = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf-8'));
  await db.init({});
  const target = db.getFilePath();

  let inserted = 0;
  for (const b of payload.books) {
    const exists = db.get('SELECT id FROM books WHERE title = ?', [b.title]);
    if (exists) {
      console.log('跳过（已存在）：' + b.title);
      continue;
    }
    db.transaction(() => {
      db.run('INSERT INTO books (title, intro) VALUES (?, ?)', [b.title, b.intro || '']);
      const bookId = db.get('SELECT id FROM books WHERE title = ?', [b.title]).id;

      if (b.master_outline) {
        db.run('UPDATE books SET master_outline = ? WHERE id = ?', [b.master_outline, bookId]);
      }

      let volumeId = null;
      if (b.volume) {
        db.run(
          'INSERT INTO volumes (book_id, title, intro, outline, summary, sort_order) VALUES (?, ?, ?, ?, ?, 1)',
          [bookId, b.volume.title, b.volume.intro || '', b.volume.outline || '', b.volume.summary || '']
        );
        volumeId = db.get('SELECT id FROM volumes WHERE book_id = ? ORDER BY id LIMIT 1', [bookId]).id;
      }

      (b.chapters || []).forEach((ch, i) => {
        db.run(
          'INSERT INTO chapters (book_id, volume_id, title, content, summary, beat, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [bookId, volumeId, ch.title, ch.content || '', ch.summary || '', ch.beat || '', i + 1]
        );
      });

      (b.characters || []).forEach(c => {
        db.run(
          'INSERT INTO characters (book_id, name, role, appearance, personality, background) VALUES (?, ?, ?, ?, ?, ?)',
          [bookId, c.name, c.role || '', c.appearance || '', c.personality || '', c.background || '']
        );
      });

      (b.world || []).forEach(w => {
        db.run('INSERT INTO world_entries (book_id, title, content) VALUES (?, ?, ?)', [bookId, w.title, w.content || '']);
      });
    });
    inserted++;
    console.log('已播种：《' + b.title + '》 ' + (b.chapters || []).length + ' 章 / '
      + (b.characters || []).length + ' 人物 / ' + (b.world || []).length + ' 条世界观');
  }

  db.saveNow();
  db.close();
  console.log('完成：新增 ' + inserted + ' 部示例作品 → ' + target);
}

main().catch(e => { console.error('播种失败：' + e.message); process.exit(1); });
