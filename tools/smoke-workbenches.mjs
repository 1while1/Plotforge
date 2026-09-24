// 工作台 API 冒烟测试：逐工作台验证后端端点（只读为主 + 少量自清理的边界探测）。
// 用法：node tools/smoke-workbenches.mjs   （默认打 3200，可用 SMOKE_BASE 覆盖；目标须是隔离的数据副本）
// 背景：2026-09-10 工作台健康度审查用它确认了 6 个后端缺陷；修复后 36/36 通过。
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3200';
const results = [];
let failed = 0;

async function call(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', Origin: BASE } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }
  return { status: res.status, data };
}

function check(group, name, fn) {
  return fn().then(r => {
    results.push({ group, name, ...r });
    if (!r.ok) failed++;
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${group} · ${name}${r.note ? ' — ' + r.note : ''}`);
  }).catch(e => {
    failed++;
    results.push({ group, name, ok: false, note: e.message });
    console.log(`[FAIL] ${group} · ${name} — ${e.message}`);
  });
}

function expect200(r, extra) {
  if (r.status !== 200) return { ok: false, note: `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}` };
  if (extra && !extra(r.data)) return { ok: false, note: `响应结构不符: ${JSON.stringify(r.data).slice(0, 200)}` };
  return { ok: true, note: '' };
}

async function main() {
  // 找一本有数据的书
  const books = await call('GET', '/api/books');
  const anyang = books.data.books.find(b => b.title === '安阳师范');
  const B = '/api/books/' + anyang.id;
  console.log(`目标书籍: ${anyang.title} (id=${anyang.id})`);

  await check('书架', 'GET /api/books', () => call('GET', '/api/books').then(r => expect200(r, d => Array.isArray(d.books))));
  await check('书架', 'GET /api/books/:id', () => call('GET', B).then(r => expect200(r, d => d.book && d.book.title)));

  await check('写作页', 'GET volumes', () => call('GET', B + '/volumes').then(r => expect200(r, d => Array.isArray(d.volumes))));
  await check('写作页', 'GET chapters', () => call('GET', B + '/chapters').then(r => expect200(r, d => Array.isArray(d.chapters))));
  await check('写作页', 'GET chat 历史', () => call('GET', B + '/chat').then(r => expect200(r, d => Array.isArray(d.messages))));
  await check('写作页', 'GET state 旧状态簿', () => call('GET', B + '/state').then(r => expect200(r)));
  await check('写作页', 'GET context-status', () => call('GET', B + '/context-status').then(r => expect200(r)));
  await check('写作页', 'GET context-breakdown', () => call('GET', B + '/context-breakdown').then(r => expect200(r)));
  await check('写作页', 'GET vector-status', () => call('GET', B + '/vector-status').then(r => expect200(r)));

  await check('人物中枢', 'GET characters (limit=200)', () => call('GET', B + '/characters?limit=200').then(r => expect200(r, d => Array.isArray(d.characters) && d.characters.length > 0)));
  const chars = await call('GET', B + '/characters?limit=200');
  const cid = chars.data.characters[0].id;
  await check('人物中枢', 'GET characters/:id (档案上下文)', () => call('GET', `${B}/characters/${cid}`).then(r => expect200(r, d => d.character && Array.isArray(d.aliases) && d.relation_summary && d.timeline_summary)));
  await check('人物中枢', 'GET characters/:id/relations', () => call('GET', `${B}/characters/${cid}/relations?secrecy=all&lifecycle=all`).then(r => expect200(r, d => Array.isArray(d.items))));
  await check('人物中枢', 'GET relation-types', () => call('GET', B + '/relation-types').then(r => expect200(r, d => Array.isArray(d.items))));
  await check('人物中枢', 'GET characters/:id/states', () => call('GET', `${B}/characters/${cid}/states`).then(r => expect200(r, d => Array.isArray(d.states) || Array.isArray(d.items))));
  await check('人物中枢', 'GET state-fields', () => call('GET', B + '/state-fields').then(r => expect200(r, d => Array.isArray(d.items))));
  await check('人物中枢', 'GET advisor sessions', () => call('GET', `${B}/characters/${cid}/advisor/sessions?limit=20`).then(r => expect200(r, d => Array.isArray(d.items))));
  await check('人物中枢(时间线)', 'GET ledger/events?character_id=', () => call('GET', `${B}/ledger/events?character_id=${cid}&limit=200`).then(r => expect200(r, d => Array.isArray(d.events) || Array.isArray(d.items))));

  await check('故事台账', 'GET ledger/progress', () => call('GET', B + '/ledger/progress').then(r => expect200(r)));
  await check('故事台账', 'GET ledger/proposals?status=pending', () => call('GET', B + '/ledger/proposals?status=pending').then(r => expect200(r, d => Array.isArray(d.items) || Array.isArray(d.proposals))));
  await check('故事台账', 'GET ledger/events?limit=200', () => call('GET', B + '/ledger/events?limit=200').then(r => expect200(r)));
  await check('故事台账', 'GET ledger/threads?status=open', () => call('GET', B + '/ledger/threads?status=open').then(r => expect200(r, d => Array.isArray(d.items))));
  await check('故事台账', 'GET ledger/issues', () => call('GET', B + '/ledger/issues').then(r => expect200(r)));
  await check('故事台账', 'GET ledger/backfill', () => call('GET', B + '/ledger/backfill').then(r => expect200(r)));

  await check('大纲工作台', 'GET volumes+chapters', () => Promise.all([call('GET', B + '/volumes'), call('GET', B + '/chapters')]).then(([v, c]) => (v.status === 200 && c.status === 200) ? { ok: true } : { ok: false, note: `v=${v.status} c=${c.status}` }));

  await check('世界观工作台', 'GET world', () => call('GET', B + '/world').then(r => expect200(r, d => Array.isArray(d.entries))));
  await check('世界观工作台', 'GET evidence/search', () => call('POST', B + '/evidence/search', { query: '陈婷', top_k: 3 }).then(r => expect200(r, d => Array.isArray(d.hits))));

  await check('阅读/精修', 'GET chapters/:cid 正文', async () => {
    const chs = await call('GET', B + '/chapters');
    const withContent = chs.data.chapters.find(c => c.content);
    if (!withContent) return { ok: false, note: '无带正文章节' };
    return call('GET', `${B}/chapters/${withContent.id}`).then(r => expect200(r, d => d.chapter && typeof d.chapter.content === 'string'));
  });

  await check('设置', 'GET /api/settings', () => call('GET', '/api/settings').then(r => expect200(r, d => d.settings && !('api_key' in d.settings))));
  await check('Agent', 'GET /api/agent/tools', () => call('GET', '/api/agent/tools').then(r => expect200(r, d => Array.isArray(d.tools) || Array.isArray(d.items))));

  // ===== 边界/缺陷验证（只读探测，不改数据）=====
  console.log('\n===== 边界探测 =====');

  // A. 章节跨书挂卷：把 A 书章节 PUT volume_id 指向 B 书卷 —— 探测后再改回
  await check('边界:跨书挂卷', 'PUT chapters/:cid volume_id=他书卷', async () => {
    const b2 = books.data.books.find(b => b.id !== anyang.id);
    const v2 = await call('GET', `/api/books/${b2.id}/volumes`);
    const chs = await call('GET', B + '/chapters');
    const ch = chs.data.chapters[0];
    if (!v2.data.volumes.length) return { ok: true, note: '他书无卷，跳过' };
    const r = await call('PUT', `${B}/chapters/${ch.id}`, { volume_id: v2.data.volumes[0].id });
    if (r.status === 200) {
      await call('PUT', `${B}/chapters/${ch.id}`, { volume_id: ch.volume_id }); // 还原
      return { ok: false, note: `服务端接受了跨书 volume_id（HTTP 200）——章节 ${ch.id} 曾被挂到他书卷 ${v2.data.volumes[0].id}，已还原` };
    }
    return { ok: true, note: `被拒绝 HTTP ${r.status}` };
  });

  // B. 不存在的书的 progress / issues / state
  await check('边界:不存在书', 'GET ledger/progress (bookId=999999)', () => call('GET', '/api/books/999999/ledger/progress').then(r => r.status === 404 ? { ok: true, note: '404' } : { ok: false, note: `HTTP ${r.status}（应为404）` }));
  await check('边界:不存在书', 'GET ledger/issues (bookId=999999)', () => call('GET', '/api/books/999999/ledger/issues').then(r => r.status === 404 ? { ok: true, note: '404' } : { ok: false, note: `HTTP ${r.status}（应为404）` }));
  await check('边界:不存在书', 'GET state (bookId=999999)', () => call('GET', '/api/books/999999/state').then(r => r.status === 404 ? { ok: true, note: '404' } : { ok: false, note: `HTTP ${r.status}（应为404）` }));
  await check('边界:不存在书', 'POST chapters (bookId=999999)', () => call('POST', '/api/books/999999/chapters', { title: 'x' }).then(r => r.status === 404 ? { ok: true, note: '404' } : { ok: false, note: `HTTP ${r.status}（应为404）` }));

  // C. volumes 非字符串 intro 崩溃探测（在临时书上做）
  await check('边界:类型校验', 'POST volumes intro=数字', async () => {
    const nb = await call('POST', '/api/books', { title: 'SMOKE-TMP-类型校验' });
    const bid = nb.data.book.id;
    const r = await call('POST', `/api/books/${bid}/volumes`, { title: 't', intro: 12345 });
    await call('DELETE', `/api/books/${bid}`);
    return (r.status === 400) ? { ok: true, note: '400 拒绝' } : { ok: false, note: `HTTP ${r.status} ${JSON.stringify(r.data).slice(0,120)}（intro 非字符串未被 400 拒绝）` };
  });

  // D. 孤儿章节目录问题数据探测：是否存在 volume_id 为 null 但书里有卷的章节
  await check('边界:孤儿章节', '数据库中 volume_id 空但有卷的书', async () => {
    const chs = await call('GET', B + '/chapters');
    const vols = await call('GET', B + '/volumes');
    const orphan = chs.data.chapters.filter(c => !c.volume_id);
    const orphanInDeletedVol = chs.data.chapters.filter(c => c.volume_id && !vols.data.volumes.some(v => v.id === c.volume_id));
    return { ok: true, note: `volume_id=null 章节 ${orphan.length} 个；指向已删卷 ${orphanInDeletedVol.length} 个；共 ${vols.data.volumes.length} 卷。前端目录在 volumes.length>0 时${orphan.length ? '会漏掉这 ' + orphan.length + ' 章' : '无孤儿章'}` };
  });

  console.log(`\n===== 冒烟结果：${results.length - failed} 通过 / ${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
