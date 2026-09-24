// S1-01 / C01：持久化结果契约（01-架构与接口契约 §2）。
// 业务写已应用到内存之后调用：同步尝试落盘，把 durable/pending 作为保存结果的一部分
// 交还调用方。“已应用未落盘”不是“没有发生”——客户端不得把 PERSISTENCE_PENDING 当
// 业务未执行而重放 create/append/delete；恢复落盘由 db 层的受追踪自动重试完成，
// flush 仅写盘、不重做任何业务写入。
const db = require('./db');

const PENDING_CODE = 'PERSISTENCE_PENDING';

// durable=true 表示此刻没有待落盘改动（含本入口之前的关键写已 saveNow 成功的情形），
// 避免对已落盘状态做多余的整库重写；否则同步尝试一次落盘并报告结果。
function persistenceState() {
  const status = db.getPersistenceStatus();
  if (!status.dirty && !status.pending && !status.retryScheduled) {
    return { durable: true, pending: false, code: null };
  }
  if (db.saveNow()) {
    return { durable: true, pending: false, code: null };
  }
  return { durable: false, pending: true, code: PENDING_CODE };
}

// 关键写出口统一接入点：result 为本次已应用的业务载荷
function persistResult(result) {
  return { result, applied: true, persistence: persistenceState() };
}

// POST /api/persistence/flush 用：applied=false 表示本就无待落盘改动
function flushNow() {
  const status = db.getPersistenceStatus();
  if (!status.dirty && !status.pending && !status.retryScheduled) {
    return { applied: false, persistence: { durable: true, pending: false, code: null } };
  }
  const ok = db.saveNow();
  return {
    applied: ok,
    persistence: { durable: ok, pending: !ok, code: ok ? null : PENDING_CODE },
  };
}

module.exports = { persistResult, persistenceState, flushNow, PENDING_CODE };
