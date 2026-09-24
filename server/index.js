const db = require('./db');
const { createApp } = require('./app');
const { warmUp } = require('./vector/embed');

const PORT = process.env.PORT || 3000;
// 默认只绑回环地址：全部接口无鉴权，绑 0.0.0.0 会让同一局域网内任何人读到设置与书库。
// 确需对外时显式设 HOST=0.0.0.0 启动，属主动选择而非默认暴露。
const HOST = process.env.HOST || '127.0.0.1';

// 启动后补建缺失的向量索引（D2-04：indexBookMissing 此前无任何调用方，连测试都没有）。
// 定稿章节若因历史原因（外键关闭期删书留下的不一致、或某次索引失败）缺 embeddings，这里逐书补齐。
// 异步执行、幂等（只补 locked=1 且无 embeddings 的章节）、失败不影响服务。
async function backfillMissingIndexes() {
  try {
    const indexer = require('./vector/indexer');
    const books = db.all('SELECT id FROM books');
    for (const b of books) {
      const r = await indexer.indexBookMissing(b.id);
      if (r.chapters > 0) console.log(`[vector] 启动补索引 book ${b.id}: ${r.chapters} 章 / ${r.chunks} 块`);
    }
  } catch (e) {
    console.error('[vector] 启动补索引失败（不影响服务）:', e.message);
  }
}

db.init().then(() => {
  // S2-01：重启恢复——上一次进程残留的 running 运行标 interrupted（不暗中续写），
  // awaiting_confirmation 保留（确认卡有效期由 actionStore 自己管）。
  try {
    const recovered = require('./runtime/run-service').recoverInterruptedRuns();
    if (recovered.interrupted) console.log(`[run-service] 重启恢复：${recovered.interrupted} 个未结算运行标记为 interrupted`);
  } catch (e) { console.error('[run-service] 重启恢复失败（不影响服务）:', e.message); }
  // S2-02 / C07：执行中断的确认卡标 interrupted（结果不确定，不可盲重放）——
  // 有 durable 结算凭据的按凭据恢复既有 approved/failed。
  try {
    const recoveredActions = require('./actionStore').recoverInterruptedActions();
    if (recoveredActions.interrupted || recoveredActions.restored) {
      console.log(`[actionStore] 重启恢复：${recoveredActions.interrupted} 个执行中断确认标记为 interrupted，${recoveredActions.restored} 个凭 durable 凭据恢复`);
    }
  } catch (e) { console.error('[actionStore] 重启恢复失败（不影响服务）:', e.message); }
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`AI 小说工坊已启动: http://localhost:${PORT} (监听 ${HOST})`);
    warmUp(); // 异步预热本地 embedding，消除首次索引冷启动；失败不影响服务
    backfillMissingIndexes(); // 异步补建缺失索引；失败不影响服务
    // 断点续跑（3.1 第二部分）：死在半路的回填任务自动续跑一次（幂等跳过已成功抽取章节，
    // resume_count 防崩溃循环）；异步执行、失败不影响服务
    require('./domain/backfill').resumeInterrupted()
      .then(r => { if (r.resumed.length) console.log(`[backfill] 已自动续跑重启前中断的任务: ${r.resumed.join(', ')}`); })
      .catch(e => console.error('[backfill] 断点续跑启动失败（不影响服务）:', e.message));
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
