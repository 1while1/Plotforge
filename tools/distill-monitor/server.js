// 作者印记蒸馏 map 进度看板（只读服务，2026-09-13 加：双线长跑需要实时视图）
//
// 用法：node tools/distill-monitor/server.js          → http://127.0.0.1:3199/
//      PORT=3200 node tools/distill-monitor/server.js  （换端口）
//
// 设计约束（不得违反）：
//  - **只读**：仅读 data/ 下的 map 产物（JSONL）与两个启动器日志；不写任何文件、不连数据库、
//    不碰 dev 常驻实例（3100）。它与跑 map 的进程无交互，停掉看板不影响任何在跑的任务。
//  - **零依赖**：只用 node 内置模块（http/fs/path），不引第三方包。
//  - 绑定 127.0.0.1（不给局域网暴露：日志里可能含渠道信息）。
//  - 任何读取失败都必须降级为「该项为空」，绝不 500——看板本身不能成为故障点。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 产物根可用环境变量改指（单测用临时目录构造夹具；缺省仍是仓库根）
const DATA_ROOT = process.env.DISTILL_MONITOR_DATA_ROOT || ROOT;
const PORT = Number(process.env.PORT || 3199);
const REFRESH_HINT_MS = 3000;

// 作者与块总数（口径：报告 09 §6.2 的块数盘点，同一条切块路径：剔章题 → 掩码 → 8000 字滑窗 step 7800）
const AUTHORS = [
  { name: '白石', total: 1868, works: { 太虚古界: 964, 蔽霄: 904 } },
  { name: '青崖', total: 1582, works: { 问魔: 655, 逆仙: 927 } },
  { name: '溪上老翁', total: 332, works: {} },
  { name: '晚棠未开', total: 316, works: {} },
];

// 两条主线的分配（与 data/tmp-p8/run-map-*.sh 一致；只看日志与产物，不猜进程）
// recovery:true 的线路是「补块线」——它没有固定的作者配额（只跑缺块），故不参与进度/ETA 统计，
// 只展示状态与日志尾部（否则会与主线的完成数重复计数）。
const LANES = [
  { id: 'agnes', label: 'Agnes 官方线', provider: 'agnes', authors: ['白石', '青崖'], log: 'data/corpus/dict/map-agnes.log', pid: 'data/tmp-p8/map-agnes.pid' },
  { id: 'stepfun', label: 'StepFun 线', provider: 'stepfun', authors: ['溪上老翁', '晚棠未开'], log: 'data/corpus/dict/map-stepfun.log', pid: 'data/tmp-p8/map-stepfun.pid' },
  { id: 'fill', label: '补块线（回收 + 换渠道补齐）', provider: 'agnes', authors: [], recovery: true, log: 'data/corpus/dict/map-fill.log', pid: null },
];

const LANE_RATE_WINDOW_MIN = 10;   // 速率/ETA 用最近 N 分钟的完成节奏算
const STALE_MS = 5 * 60 * 1000;    // 超过 N 毫秒没有新行 = 疑似停滞

function safeRead(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function safeStat(file) { try { return fs.statSync(file); } catch { return null; } }
function tailLines(text, n) { return text ? text.split('\n').filter(Boolean).slice(-n) : []; }

/** 单个作者的产物统计（去重块口径：后行覆盖前行）。 */
function authorStats(author, dataRoot = DATA_ROOT) {
  const dir = path.join(dataRoot, 'data', 'corpus', `src-${author.name}`, 'map');
  const out = {
    name: author.name, total: author.total, done: 0, remaining: author.total,
    kept: 0, dropped: 0, keptRelaxed: 0, relaxedFresh: 0, doneRelaxed: 0, input: 0, output: 0, splits: 0,
    models: {}, works: [], archived: [], lastAt: null, rows: 0,
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  // 放宽口径产物（派生集，见报告 09 §6.9/§6.10）：验证默认应看这一列——严格口径比它少 ~33%
  const relDir = path.join(dataRoot, 'data', 'corpus', `src-${author.name}`, 'map-relaxed');
  const lastByWork = {};
  for (const f of names) {
    if (/\.jsonl$/.test(f)) {
      const work = f.replace(/\.jsonl$/, '');
      const text = safeRead(path.join(dir, f));
      if (text == null) continue;
      const last = new Map();
      let rows = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }   // 腐败行忽略（与 map.js 同语义）
        rows++;
        last.set(r.chunkIndex, r);
      }
      out.rows += rows;
      out.done += last.size;
      let workKept = 0;
      for (const r of last.values()) {
        workKept += (r.kept || []).length;
        out.kept += (r.kept || []).length;
        out.dropped += (r.dropped || []).length;
        out.input += (r.usage && r.usage.input) || 0;
        out.output += (r.usage && r.usage.output) || 0;
        if (r.splits) out.splits += 1;
        const key = `${r.provider || 'stepfun'}/${r.model || 'step-3.7-flash'}`;
        out.models[key] = (out.models[key] || 0) + 1;
        if (r.at && (!out.lastAt || r.at > out.lastAt)) out.lastAt = r.at;
      }
      // 放宽口径：只统计 sha 与主集一致的行（词典/切块变过之后的老行不算，与 map-final-stats.js 同口径）
      let workRelaxed = 0;
      let workRelaxedFresh = 0;
      const relText = safeRead(path.join(relDir, f));
      if (relText != null) {
        const rel = new Map();
        for (const line of relText.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let r2;
          try { r2 = JSON.parse(line); } catch { continue; }
          if (Number.isInteger(r2.chunkIndex)) rel.set(r2.chunkIndex, r2);
        }
        for (const r of last.values()) {
          const rr = rel.get(r.chunkIndex);
          if (rr && rr.sha256 === r.sha256) { workRelaxed += (rr.kept || []).length; workRelaxedFresh++; }
        }
      }
      out.keptRelaxed += workRelaxed;
      out.relaxedFresh += workRelaxedFresh;
      out.doneRelaxed += last.size;
      lastByWork[work] = { work, rows, blocks: last.size, kept: workKept,
        keptRelaxed: workRelaxed, relaxedFresh: workRelaxedFresh,
        total: (author.works && author.works[work]) || null };
    } else if (/\.jsonl\./.test(f)) {
      out.archived.push(f);
    }
  }
  out.works = Object.values(lastByWork).sort((a, b) => b.blocks - a.blocks);
  out.remaining = Math.max(0, author.total - out.done);
  out.retention = out.kept + out.dropped ? out.kept / (out.kept + out.dropped) : null;
  out.keptPerBlock = out.done ? out.kept / out.done : null;
  out.keptPerBlockRelaxed = out.done ? out.keptRelaxed / out.done : null;
  // relaxedStale = 有主集行但 map-relaxed 落后（快照语义：主集新增行后要重跑 revalidate）
  out.relaxedStale = out.relaxedFresh < out.done;
  return out;
}

/** 线级统计：日志尾部 + 失败计数 + 最近 N 分钟完成速率 + ETA。 */
function laneStats(lane, authors) {
  const logText = safeRead(path.join(ROOT, lane.log));
  const lines = logText ? logText.split('\n') : [];
  const tail = tailLines(logText, 60);
  const heartbeat = [...lines].reverse().find((l) => /心跳: 完成 /.test(l)) || null;
  const failures = lines.filter((l) => /本轮重试耗尽/.test(l));
  const hardFails = lines.filter((l) => /重试后仍失败/.test(l));
  const markers = lines.filter((l) => /=====|----- 作者/.test(l)).slice(-6);
  const mine = authors.filter((a) => lane.authors.includes(a.name));
  const done = mine.reduce((s, a) => s + a.done, 0);
  const remaining = mine.reduce((s, a) => s + a.remaining, 0);
  // 最近 10 分钟的完成节奏（跨该线各作者的产出行）
  const cutoff = Date.now() - LANE_RATE_WINDOW_MIN * 60 * 1000;
  let recent = 0;
  const times = [];
  for (const a of mine) {
    const dir = path.join(ROOT, 'data', 'corpus', `src-${a.name}`, 'map');
    for (const w of a.works) {
      const text = safeRead(path.join(dir, `${w.work}.jsonl`));
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r.at) continue;
        const t = Date.parse(r.at);
        if (t >= cutoff) { recent++; times.push(t); }
      }
    }
  }
  let perMin = null, etaMinutes = null;
  if (times.length >= 3) {
    const spanMin = Math.max(0.5, (Math.max(...times) - Math.min(...times)) / 60000);
    perMin = times.length / spanMin;
    etaMinutes = perMin > 0 ? remaining / perMin : null;
  }
  const newestRowAt = mine.reduce((m, a) => (a.lastAt && (!m || a.lastAt > m) ? a.lastAt : m), null);
  const ageMs = newestRowAt ? Date.now() - Date.parse(newestRowAt) : null;
  const running = ageMs != null && ageMs < STALE_MS;   // 产出新鲜度（供状态判定）
  const logStat = safeStat(path.join(ROOT, lane.log));
  const logAgeMs = logStat ? Date.now() - logStat.mtimeMs : null;
  // 补块线没有作者配额：状态看「日志是否还在写」，进度/ETA 一律留空（防与主线重复计数）
  // 主线的状态优先看日志里的生命周期标记（===== X 线开始/结束），其次才看剩余与产出新鲜度——
  // 「线已按计划收工」与「跑着但卡住」必须能区分开（前者还可能有缺块被补块线接手）。
  const idxStart = lines.reduce((m, l, i) => (/线开始/.test(l) ? i : m), -1);
  const idxEnd = lines.reduce((m, l, i) => (/线结束/.test(l) ? i : m), -1);
  const finished = idxEnd > idxStart;
  const status = lane.recovery
    ? (logAgeMs == null ? 'unknown' : (logAgeMs < STALE_MS ? 'running' : 'stale'))
    : (finished ? 'done' : (running === false ? 'stale' : 'running'));
  return {
    id: lane.id, label: lane.label, provider: lane.provider, authors: lane.authors,
    recovery: !!lane.recovery, logAgeMs,
    done: lane.recovery ? null : done, remaining: lane.recovery ? null : remaining,
    perMin: lane.recovery ? null : perMin, etaMinutes: lane.recovery ? null : etaMinutes,
    status, ageMs, newestRowAt,
    logFile: lane.log, heartbeat, failures: failures.length, lastFailures: failures.slice(-5),
    hardFails: hardFails.slice(-5), markers, tail: tailLines(logText, 25),
    pidFile: lane.pid || null,
    // path.join 收到 null 会抛错（补块线没有 pid 文件）——必须先判空再 join
    pid: lane.pid ? ((safeRead(path.join(ROOT, lane.pid)) || '').trim() || null) : null,
  };
}

function buildStatus() {
  const authors = AUTHORS.map(authorStats);
  const lanes = LANES.map((l) => laneStats(l, authors));
  const totals = authors.reduce((t, a) => ({
    done: t.done + a.done, total: t.total + a.total, kept: t.kept + a.kept, dropped: t.dropped + a.dropped,
    keptRelaxed: t.keptRelaxed + a.keptRelaxed,
    input: t.input + a.input, output: t.output + a.output, archived: t.archived + a.archived.length,
  }), { done: 0, total: 0, kept: 0, dropped: 0, keptRelaxed: 0, input: 0, output: 0, archived: 0 });
  totals.retention = totals.kept + totals.dropped ? totals.kept / (totals.kept + totals.dropped) : null;
  const runningPerMin = lanes.reduce((s, l) => s + (l.perMin || 0), 0);
  totals.perMin = runningPerMin || null;
  const remaining = Math.max(0, totals.total - totals.done);
  totals.remaining = remaining;
  totals.etaMinutes = runningPerMin > 0 ? remaining / runningPerMin : null;
  totals.etaAt = totals.etaMinutes ? new Date(Date.now() + totals.etaMinutes * 60000).toISOString() : null;
  totals.relaxedStale = authors.some((a) => a.relaxedStale);
  return { now: new Date().toISOString(), refreshMs: REFRESH_HINT_MS, lanes, authors, totals };
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/status') {
    let body;
    try { body = JSON.stringify(buildStatus()); }
    catch (e) { body = JSON.stringify({ error: String((e && e.message) || e) }); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (url === '/' || url === '/index.html') {
    const html = safeRead(path.join(__dirname, 'index.html'));
    res.writeHead(html ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html || 'index.html 读取失败');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[monitor] 看板已启动: http://127.0.0.1:${PORT}/  （只读，Ctrl-C 退出）`);
  });
}

// 导出给单测用（require 本模块不再自动监听端口）
module.exports = { authorStats, buildStatus, laneStats, AUTHORS, LANES };
