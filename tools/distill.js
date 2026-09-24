#!/usr/bin/env node
// 作者印记蒸馏 CLI（方案 §3 五层管线的离线入口，任务书 P8）。
//
// 用法：node tools/distill.js <命令> [参数]
//   fingerprint <语料根>      L1 指纹 + 源集登记（写 corpus_sources/corpus_docs）+ 留一书验证
//   mask <语料根> [--author X] [--max-ratio 0.08]  专名词典构建 + 掩码验收（第 0 步）
//   map <语料根> [--author X] [--work W] [--limit N] [--provider stepfun|agnes] [--model ID] [--concurrency N]
//       L2 结构化 map（第 2 步）
//   revalidate <语料根> --author X [--work W]   离线复核（第 2.5 步，零 LLM 调用）：把已落盘的
//       kept+dropped 条目按「空白不敏感」重过一遍闸门 4，产物写 map-relaxed/（原 JSONL 不动）
//   l3 <语料根> --author X [--provider agnes|stepfun] [--concurrency N] [--max-items N] [--no-reduce]
//       L3 四道闸门 + 树状 reduce（第 3 步）
//   samples <语料根> --author X [--pack 卡名] [--k 8] [--seed N] [--dry-run]
//       L4 选样 + 范文入库（第 4 步）：k-means 三路选样 → 卫生检查 → 写 style_samples + 卡挂 source_refs
//
// 铁律：
//   1) 写库命令必须显式 NOVEL_DB_FILE=<路径>——本工具是离线批处理，
//      绝不允许隐式写 dev 常驻实例的 data/novel.db（sql.js 全库内存态 + 整文件覆盖写，双开互相覆盖）。
//   2) 语料 txt 与 data/corpus/ 产物都被 .gitignore 忽略，不得提交。
//   3) 切块全部走 tools/distill/util.js 的滑窗（≤500 字断言），不复用 indexer.chunkText。
'use strict';

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('用法: node tools/distill.js <命令> <语料根> [选项]');
    console.log('  fingerprint  源集登记 + L1 指纹 + 留一书验证（需 NOVEL_DB_FILE）');
    console.log('  clean        语料清洗（站点水印/推广块/符号行/章末标记/HTML/PUA）');
    console.log('  mask         按作者建词典并掩码（上限取词表 maxRatio）');
    console.log('  map          L2 结构化 map（--author 必填；--provider stepfun|agnes、--concurrency、--limit）');
    console.log('  revalidate   离线复核（零 LLM）：空白不敏感 + 维度标签归一，产物写 map-relaxed/');
    console.log('  l3           L3 闸门 + 树状 reduce（--author 必填；--provider agnes、--timeout、--no-reduce 走对照路径）');
    console.log('  samples      L4 选样 + 范文入库（--author 必填；写卡与 style_samples，需 NOVEL_DB_FILE）');
    console.log('  l5           L5 卡片产出（--author 必填；--contrast 同题材作者；写人设/指纹/规则，需 NOVEL_DB_FILE）');
    process.exit(cmd ? 0 : 1);
  }
  // 参数解析见 tools/distill/args.js（布尔开关的静默做反缺陷在那里有单测钉住）
  const { args, flagsWithoutValue, root } = require('./distill/args').parseArgs(rest);

  // 数值选项校验（2026-09-12 核查发现：--limit 0 / --limit abc / --limit 缺值 都会因
  // falsy 判断静默退化为「全量跑」——一次误输入就是全量 LLM 计费；并发同理落到默认值）。
  // 校验放在任何 require/网络/key 读取之前，失败即退出，测试可秒级验证。
  for (const name of ['limit', 'concurrency', 'max-tokens', 'max-items', 'timeout']) {
    if (flagsWithoutValue.has(name)) {
      console.error(`参数 --${name} 缺少取值（拒绝执行，避免静默退化为默认行为）`);
      process.exit(1);
    }
    if (args[name] === undefined) continue;
    const n = Number(args[name]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`参数 --${name} 必须为正整数，实际收到 ${JSON.stringify(args[name])}（拒绝执行）`);
      process.exit(1);
    }
  }
  // 掩码强度上限：0<r<1 的小数（0.08=8%）。写错成 8 或 0 都会静默毁掉词典——必须拒收。
  if (flagsWithoutValue.has('max-ratio')) {
    console.error('参数 --max-ratio 缺少取值（拒绝执行）');
    process.exit(1);
  }
  if (args['max-ratio'] !== undefined) {
    const r = Number(args['max-ratio']);
    if (!Number.isFinite(r) || r <= 0 || r >= 1) {
      console.error(`参数 --max-ratio 必须是 (0,1) 之间的小数（如 0.08），实际收到 ${JSON.stringify(args['max-ratio'])}（拒绝执行）`);
      process.exit(1);
    }
  }

  if (cmd === 'fingerprint') {
    await runFingerprint(root);
  } else if (cmd === 'mask') {
    await runMask(root, args);
  } else if (cmd === 'clean') {
    await runClean(root, args);
  } else if (cmd === 'map') {
    await runMap(root, args);
  } else if (cmd === 'revalidate') {
    await runRevalidate(root, args);
  } else if (cmd === 'l3') {
    await runL3(root, args);
  } else if (cmd === 'samples') {
    await runSamples(root, args);
  } else if (cmd === 'l5') {
    await runL5Cmd(root, args);
  } else {
    console.error(`未知命令: ${cmd}`);
    process.exit(1);
  }
}

// ---- fingerprint：源集登记 + L1 指纹 + 留一书验证（第 1 步验收命令）----

async function runFingerprint(root) {
  if (!root) { console.error('用法: node tools/distill.js fingerprint <语料根>'); process.exit(1); }
  const dbFile = process.env.NOVEL_DB_FILE;
  if (!dbFile) {
    console.error('拒绝执行：写库命令必须显式 NOVEL_DB_FILE=<临时库或指定库路径>。\n' +
      '（本工具绝不隐式写 data/novel.db——dev 常驻实例持锁，sql.js 双开会整库互相覆盖。）');
    process.exit(1);
  }
  console.log(`[distill] 目标库: ${dbFile}`);

  const db = require('../server/db');
  const util = require('./distill/util');
  const fp = require('./distill/fingerprint');
  const fs = require('fs');

  await db.init({});
  const files = util.readCorpus(root);
  console.log(`[distill] 语料 ${files.length} 个文件，作者 ${new Set(files.map(f => f.author)).size} 位`);

  // 按作者聚合：指纹（全文拼接口径）+ 文档登记
  const byAuthor = new Map();
  for (const f of files) {
    if (!byAuthor.has(f.author)) byAuthor.set(f.author, []);
    byAuthor.get(f.author).push(f);
  }

  // 留一书验证与分离度需要全语料的文件级/块级特征
  const fileItems = [];
  const blockItems = [];
  const featsByAuthor = {};
  for (const [author, authorFiles] of byAuthor) {
    const texts = authorFiles.map(f => util.readUtf8(f.file));
    const full = util.stripChapterTitles(texts.join('\n'));
    featsByAuthor[author] = { author, files: authorFiles, texts, full };

    for (const f of authorFiles) {
      const stripped = util.stripChapterTitles(util.readUtf8(f.file));
      const feat = fp.featOf(stripped);
      if (feat) fileItems.push({ author, work: f.work, feat });
      for (const c of util.l1Chunks(stripped)) {
        const bf = fp.featOf(c.text);
        if (bf) blockItems.push({ author, work: f.work, feat: bf });
      }
    }
  }

  // z-score 与判定
  fp.zscoreAll(fileItems);
  fp.zscoreAll(blockItems);
  const sep = fp.separationReport(fileItems);
  console.log(`[distill] 分离度(文件级) ${sep.separation.toFixed(3)}  ` +
    `同作品 ${sep.sameWork.avgDelta.toFixed(3)}/${sep.sameWork.pairs} 对  ` +
    `同作者跨书 ${sep.sameAuthorCrossBook.avgDelta.toFixed(3)}/${sep.sameAuthorCrossBook.pairs} 对  ` +
    `跨作者 ${sep.crossAuthor.avgDelta.toFixed(3)}/${sep.crossAuthor.pairs} 对`);
  const loo = fp.leaveOneBookOut(blockItems);
  console.log(`[distill] 留一整本书 ${loo.correctN}/${loo.totalN}${loo.correctN === loo.totalN ? ' ✓' : ' ✗'}`);
  for (const fold of loo.folds) {
    console.log(`  ${fold.book.padEnd(14)} margin ${fold.margin.toFixed(3)}  块级投票 ${(fold.blockVoteRate * 100).toFixed(1)}%`);
  }

  // 写库：corpus_sources UPSERT（按 author 唯一）+ corpus_docs 重建
  for (const [author, info] of Object.entries(featsByAuthor)) {
    const works = [...new Set(info.files.map(f => f.work))].map(w => ({
      work: w,
      files: info.files.filter(f => f.work === w).map(f => f.rel),
    }));
    const hanCount = util.han(info.full);
    const digest = util.sha256(info.texts.join('\n'));
    const fingerprint = fp.fingerprintOf(info.full);
    // 掩码词典版本：词典存在则带上（第 0 步产物），实现方案 §3.4.1「掩码词典变更检测」
    let maskDictVersion = '';
    const dictPath = require('./distill/mask').maskDictPath(author);
    if (fs.existsSync(dictPath)) {
      maskDictVersion = JSON.parse(fs.readFileSync(dictPath, 'utf8')).version || '';
    }
    const existing = db.get('SELECT id FROM corpus_sources WHERE author = ?', [author]);
    const dirPath = `data/corpus/dict/${author}`;
    if (existing) {
      db.run(`UPDATE corpus_sources SET works_json=?, han_count=?, sha256=?, fingerprint_json=?,
              mask_dict_version=?, dir_path=?, updated_at=datetime('now','localtime') WHERE id=?`,
        [JSON.stringify(works), hanCount, digest, JSON.stringify(fingerprint), maskDictVersion, dirPath, existing.id]);
    } else {
      db.run(`INSERT INTO corpus_sources (author, works_json, han_count, sha256, fingerprint_json, mask_dict_version, dir_path)
              VALUES (?,?,?,?,?,?,?)`,
        [author, JSON.stringify(works), hanCount, digest, JSON.stringify(fingerprint), maskDictVersion, dirPath]);
    }
    const sourceId = db.get('SELECT id FROM corpus_sources WHERE author = ?', [author]).id;
    db.run('DELETE FROM corpus_docs WHERE source_id = ?', [sourceId]);
    for (const f of info.files) {
      const text = util.readUtf8(f.file);
      db.run('INSERT INTO corpus_docs (source_id, work, path, han_count, sha256) VALUES (?,?,?,?,?)',
        [sourceId, f.work, f.rel, util.han(text), util.sha256(text)]);
    }
    db.run(`INSERT INTO distill_jobs (source_id, stage, status, progress_json, stats_json)
            VALUES (?, 'fingerprint', 'done', '{}', ?)`,
      [sourceId, JSON.stringify({ separation: sep.separation, leaveOneBook: `${loo.correctN}/${loo.totalN}`, hanCount })]);
    // 指纹 JSON 也落侧文件（data/corpus/ 不进 git）
    fs.writeFileSync(`data/corpus/fingerprint-${author}.json`, JSON.stringify(fingerprint, null, 2));
    console.log(`[distill] 源集已登记: ${author}（${works.length} 作品 ${info.files.length} 文件 ${hanCount} 汉字，指纹 ${fingerprint.features ? Object.keys(fingerprint.features).length : '?'} 维）`);
  }

  await db.close();
}

// ---- mask：词典构建 + 验收（第 0 步；实现见 tools/distill/mask.js）----

async function runMask(root, args) {  if (!root) { console.error('用法: node tools/distill.js mask <语料根> [--author 某作者]'); process.exit(1); }
  const util = require('./distill/util');
  const mask = require('./distill/mask');
  const files = util.readCorpus(root);
  const authors = args.author ? [args.author] : [...new Set(files.map(f => f.author))];
  for (const author of authors) {
    const own = files.filter(f => f.author === author).map(f => util.readUtf8(f.file));
    const others = files.filter(f => f.author !== author).map(f => util.readUtf8(f.file));
    // 作者词表（tools/distill/wordlists/<author>.json，随仓库版本管理）：include + 两张证据白名单
    // + 停用词批次。词表文件缺失的作者回落旧路径（data/corpus/dict/include-<author>.json）。
    const wl = mask.loadWordlists(author);
    const externalInclude = wl.include || mask.loadInclude(author);
    // 掩码强度上限：CLI --max-ratio 优先（实验/裁决用），其次作者词表字段，最后 buildDict 默认。
    const maxRatio = args['max-ratio'] !== undefined ? Number(args['max-ratio']) : (wl.maxRatio || undefined);
    const t0 = Date.now();
    const dict = mask.buildDict(own, others, {
      include: externalInclude,
      confirmedTwoChar: wl.confirmedTwoChar,
      confirmed3Plus: wl.confirmed3Plus,
      stopWords: wl.stopWords,
      maxRatio,
    });
    mask.saveDict(author, dict);
    const wlNote = wl.source
      ? `${wl.source.split(/[\\/]/).pop()}（include ${externalInclude.length} / 白名单 ${wl.confirmedTwoChar.length}+${wl.confirmed3Plus.length} / 停用词 ${wl.stopWords.length}）`
      : `旧 include 路径 ${externalInclude.length} 项（无作者词表文件）`;
    console.log(`[mask] ${author}: ${dict.entries.length} 词条（version ${dict.version}，${wlNote}，上限 ${(dict.meta.opts.maxRatio * 100).toFixed(2)}%），构建 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (dict.meta.droppedEntries && dict.meta.droppedEntries.length) {
      console.warn(`[mask]   ⚠ 词条守卫剔除 ${dict.meta.droppedEntries.length} 条：` +
        dict.meta.droppedEntries.slice(0, 5).map((d) => `${d.name}(${d.reason})`).join(' '));
    }
    // 预算分层告警：core（include/dialog/book/pattern）不受 maxRatio 约束，它单独顶到上限时
    // n-gram 通道整层出局（词条集静默变化）。裁决法：空词表跑一遍基线，逐条比对差集。
    const mm = dict.meta;
    if (mm.ngramKept === 0 && mm.ngramDropped > 0) {
      console.warn(`[mask]   ⚠ n-gram 通道被预算整层挤空：核心层单独占比 ${(mm.coreCoverage * 100).toFixed(2)}% ` +
        `≥ maxRatio ${(mm.opts.maxRatio * 100).toFixed(2)}% → ${mm.ngramDropped} 个自动候选全部出局；` +
        `需按「空词表基线差集」逐条裁决（真专名 → include；碎片/题材词 → stopWords）`);
    } else if (mm.ngramDropped > 0) {
      console.warn(`[mask]   ⚠ n-gram 通道截断：保留 ${mm.ngramKept} / 出局 ${mm.ngramDropped}` +
        `（核心层单独占比 ${(mm.coreCoverage * 100).toFixed(2)}%）`);
    }
    const stats = mask.dictStats(dict, own.join('\n'));
    console.log(`[mask]   覆盖 ${stats.maskedChars} 字 = ${ (stats.maskRatio * 100).toFixed(2) }%  膨胀 +${((stats.expansion - 1) * 100).toFixed(2)}%`);
    const masked = mask.maskText(own.join('\n'), dict);
    const v = mask.verifySegments(own.join('\n'), masked, dict, 200);
    console.log(`[mask]   验收①逐段差分 ${v.segmentsPassed}/${v.segmentsCompared} ${v.failures.length ? '✗ ' + JSON.stringify(v.failures.slice(0, 3)) : '✓'}`);
  }
}

// ---- clean：语料清洗（水印/推广块/HTML/PUA；输出到独立目录，原始语料只读不碰）----

/** 递归收集 .txt（保留相对路径，镜像到输出目录）。 */
function walkTxt(dir, base = dir, acc = []) {
  const fs = require('fs');
  const path = require('path');
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTxt(p, base, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.txt')) acc.push({ abs: p, rel: path.relative(base, p) });
  }
  return acc;
}

async function runClean(root, args) {
  if (!root) { console.error('用法: node tools/distill.js clean <语料根> [--out <输出目录>]'); process.exit(1); }
  const fs = require('fs');
  const path = require('path');
  const util = require('./distill/util');
  const clean = require('./distill/clean');
  const REPO_ROOT = path.resolve(__dirname, '..');
  const outDir = args.out ? path.resolve(args.out) : path.join(REPO_ROOT, 'data', 'corpus', 'clean', path.basename(path.resolve(root)));
  const files = walkTxt(path.resolve(root));
  if (!files.length) { console.error(`语料根 ${root} 下没有 .txt`); process.exit(1); }
  const totals = {};
  const perFile = [];
  const allSamples = {};
  let before = 0;
  let after = 0;
  for (const f of files) {
    const text = util.readUtf8(f.abs);
    const r = clean.cleanText(text);
    const dst = path.join(outDir, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, r.text, 'utf8');
    const removedLines = Object.values(r.stats).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(r.stats)) {
      totals[k] = (totals[k] || 0) + v;
      if (!allSamples[k]) allSamples[k] = [];
      if (allSamples[k].length < 12) allSamples[k].push(...(r.samples[k] || []));
    }
    before += text.length;
    after += r.text.length;
    perFile.push({ file: f.rel, before: text.length, after: r.text.length, removedLines, stats: r.stats });
    console.log(`[clean] ${f.rel}: ${text.length} → ${r.text.length} 字（删 ${removedLines} 行：${JSON.stringify(r.stats)}）`);
  }
  const report = {
    root: path.resolve(root),
    outDir,
    beforeChars: before,
    afterChars: after,
    removedChars: before - after,
    removedRatio: (before - after) / Math.max(1, before),
    byCategory: totals,
    perFile,
    samples: allSamples,
    at: new Date().toISOString(),
  };
  const rp = path.join(outDir, 'clean-report.json');
  fs.writeFileSync(rp, JSON.stringify(report, null, 1), 'utf8');
  console.log(`[clean] 合计 ${before} → ${after} 字（删 ${((report.removedRatio) * 100).toFixed(3)}%）；` +
    `分类：${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`[clean] 输出目录 ${outDir}`);
  console.log(`[clean] 清洗报告 ${rp}（含每类前 12 条样例，供人工复核）`);
}

// ---- map：L2 结构化 map（第 2 步；实现见 tools/distill/map.js）----

async function runMap(root, args) {
  if (!root) { console.error('用法: node tools/distill.js map <语料根> [--author X] [--work W] [--limit N]'); process.exit(1); }
  const run = require('./distill/map').runMap;
  const summary = await run(root, {
    author: args.author,
    work: args.work,
    limit: args.limit ? Number(args.limit) : undefined,
    concurrency: Number(args.concurrency || 5),
    maxTokens: args['max-tokens'] ? Number(args['max-tokens']) : undefined,
    provider: args.provider || 'stepfun',   // 省略 = StepFun（既有行为）
    model: args.model || undefined,
  });
  // 有块重试耗尽 → 非零退出码（脚本化调用与上层门控按退出码判定时不得误判成功）
  if (summary.failed > 0) process.exitCode = 1;
}

// ---- revalidate：离线复核（第 2.5 步；零 LLM 调用，见 tools/distill/map.js revalidateMap）----

async function runRevalidate(root, args) {
  if (!root || !args.author) {
    console.error('用法: node tools/distill.js revalidate <语料根> --author X [--work W] [--no-ws] [--no-dims]');
    console.error('  --no-ws   关闭「空白不敏感」放宽（只做维度标签归一）');
    console.error('  --no-dims 关闭「维度标签别名」归一（只做空白放宽）');
    process.exit(1);
  }
  const out = require('./distill/map').revalidateMap(root, {
    author: args.author,
    work: args.work,
    ignoreWhitespace: !args['no-ws'],
    normalizeDims: !args['no-dims'],
  });
  for (const w of out.works) {
    if (!w.rows) { console.log(`[revalidate] ${args.author}/${w.work}: ${w.note || '无可复核行'}`); continue; }
    const by = w.recoveredBy || {};
    console.log(`[revalidate] ${args.author}/${w.work}: 复核 ${w.rows} 块（跳过旧行 ${w.stale}）` +
      `｜保留 ${w.keptBefore} → ${w.keptAfter}（补回 ${w.recovered}：空白 ${by.whitespace || 0}` +
      ` / 维度标签 ${by.dim || 0} / 两者 ${by['whitespace+dim'] || 0}）` +
      `｜仍丢弃 ${w.droppedAfter}｜产物 ${w.outFile}`);
  }
  const t = out.totals;
  console.log(`[revalidate] ${args.author} 合计（口径 ${out.policy}）: 复核 ${t.rows} 块｜` +
    `保留 ${t.keptBefore} → ${t.keptAfter}` +
    `（+${t.recovered}，${t.keptBefore ? (100 * t.recovered / t.keptBefore).toFixed(1) : '0'}%）｜仍丢弃 ${t.droppedAfter}`);
  if (t.recoveredBy) {
    console.log(`[revalidate] 补回构成: 仅空白 ${t.recoveredBy.whitespace || 0}｜仅维度标签 ${t.recoveredBy.dim || 0}` +
      `｜两者同时命中 ${t.recoveredBy['whitespace+dim'] || 0}`);
  }
}

// ---- l3：闸门 3/4 + 树状 reduce + 闸门 1/2（第 3 步；实现见 tools/distill/l3.js）----

async function runL3(root, args) {
  if (!root || !args.author) {
    console.error('用法: node tools/distill.js l3 <语料根> --author X [--provider agnes|stepfun] [--concurrency N] [--max-items N] [--max-tokens N] [--timeout ms] [--no-reduce]');
    console.error('  --no-reduce  走「同 marker 分组」的对照路径（不调 LLM，用于 A/B 取证）');
    console.error('  --timeout    单次调用超时（默认 300000ms）。**Agnes 必须调大**：实测并发 18 时单次 ≈600s，');
    console.error('               300s 会把本来能成功的调用判死（2026-09-13 青崖线 71 次叶调用死了 41 次）');
    process.exit(1);
  }
  const run = require('./distill/l3').runL3;
  const r = await run({
    corpusRoot: root,
    author: args.author,
    log: (m) => console.log(m),
    useReduce: args['no-reduce'] !== true,   // 布尔开关（见上方 BOOL_FLAGS 注释）
    reduceOpts: {
      provider: args.provider || 'agnes',
      concurrency: args.concurrency ? Number(args.concurrency) : 6,
      model: args.model || undefined,
      // 叶层批量按渠道给：Agnes 侧 id 覆盖率对批量更敏感 —— 两个渠道的合适值不一样，故做成参数。
      // ！2026-09-13 复议：原注释写「StepFun 16k 输出上限下 ~150 条就会触发截断拆分」——
      // 16k 是**我们自己设的参数**，不是渠道上限：探针（data/tmp-p8/probe-stepfun-maxtokens.js）
      // 实测 max_tokens=32000 能吐出 29,161 token 且 finish_reason=stop。l3 的默认预算已抬到 32k，
      // 见 l3.js::reduceBudget。
      ...(args['max-items'] ? { maxItems: Number(args['max-items']) } : {}),
      ...(args['max-tokens'] ? { maxTokens: Number(args['max-tokens']) } : {}),
      ...(args.timeout ? { timeoutMs: Number(args.timeout) } : {}),
    },
  });
  const s = r.summary;
  console.log(`[l3] ${args.author} 汇总（口径 ${s.useReduce ? 'reduce 先合并' : '同 marker 分组（对照）'}）`);
  console.log(`[l3] 闸门3: ok ${s.countCheck.ok}｜降档 ${s.countCheck.unverifiable}｜判死 ${s.countCheck.mismatch}` +
    `（进 reduce ${s.countCheck.fedToReduce} 条，判死 ${s.countCheck.droppedBeforeReduce} 条）`);
  if (s.reduce) {
    console.log(`[l3] reduce: 叶 ${s.reduce.leafNodes} 批 → 簇 ${s.reduce.clusters}｜层 ${s.reduce.levels.map((l) => l.level + ':' + l.calls + '调用').join(' → ')}` +
      `｜token ${s.reduce.usage.input}/${s.reduce.usage.output}｜冲突簇 ${s.reduce.conflictTraits}`);
    // 降级 ≠ 失败，但必须显眼：簇集来自更浅的一层（更碎、支撑更小），下游据此判断要不要重跑
    if (s.reduce.degradedAt != null) {
      console.log(`[l3] ⚠⚠ reduce 降级：L${s.reduce.degradedAt} 整层失败 → 簇集取自 L${s.reduce.degradedAt - 1}（summary.reduce.degradedAt）`);
    }
  }
  console.log(`[l3] 闸门1+2: 过 ${s.gate.clustersOut}｜丢 ${s.gate.dropped}（${JSON.stringify(s.gate.droppedReasons)}）` +
    `｜分档 ${JSON.stringify(s.gate.byTier)}｜冲突簇 ${s.gate.conflicts}`);
  console.log(`[l3] 维度分布: ${JSON.stringify(s.dims)}`);
  const dir = require('path').join(require('./distill/l3').REPO_ROOT, 'data/corpus', `src-${args.author}`, 'l3');
  console.log(`[l3] 产物: ${dir} 下 clusters.jsonl（通过）｜dropped.jsonl（丢弃+原因）｜conflicts.jsonl（人工裁决）｜summary.json`);
  // 失败/空产出必须让脚本化调用看得见：reduce 有失败调用、或做了 reduce 却一簇未出，
  // 都是「跑挂了」而不是「这位作家没有风格特征」（2026-09-13 首轮实跑：空产出却退出码 0）
  if (s.reduce && s.reduce.failedCalls > 0) process.exitCode = 1;
  if (!s.ok) process.exitCode = 1;
}

// ---- samples：L4 选样 + 范文入库（第 4 步；实现见 tools/distill/l4.js）----

async function runSamples(root, args) {
  if (!root || !args.author) {
    console.error('用法: node tools/distill.js samples <语料根> --author X [--pack 卡名] [--k 8] [--seed N] [--dry-run]');
    console.error('  --dry-run  只选样与卫生检查，不写库');
    process.exit(1);
  }
  const dbFile = process.env.NOVEL_DB_FILE;
  if (!dbFile) {
    console.error('拒绝执行：写库命令必须显式 NOVEL_DB_FILE=<临时库或指定库路径>。\n' +
      '（本工具绝不隐式写 data/novel.db——dev 常驻实例持锁，sql.js 双开会整库互相覆盖。）');
    process.exit(1);
  }
  console.log(`[distill] 目标库: ${dbFile}`);
  const db = require('../server/db');
  await db.init({});
  const run = require('./distill/l4').runL4;
  const r = await run({
    corpusRoot: root,
    author: args.author,
    db: db,
    log: (m) => console.log(m),
    packName: args.pack || undefined,
    k: args.k ? Number(args.k) : undefined,
    seed: args.seed ? Number(args.seed) : undefined,
    write: args['dry-run'] !== true,
  });
  const s = r.selection;
  console.log(`[samples] ${r.author}：${s.blocks} 块 → ${s.clusters} 簇（k=${s.k}，迭代 ${s.iterations}）` +
    `｜候选 ${r.hygiene.candidates} 段 → 入库 ${r.hygiene.kept} 段，剔除 ${r.hygiene.rejected} 段`);
  console.log(`[samples] 卫生：占位符边界修复 ${r.hygiene.healedEdges} 段｜问题 ${JSON.stringify(r.hygiene.problems)}` +
    `｜词典版本 ${r.dictVersion}`);
  if (args['dry-run'] !== true) {
    console.log(`[samples] 卡 #${r.packId}「${r.packName}」${r.created ? '（新建）' : ''}：` +
      `覆盖旧范文 ${r.deleted} 段｜source_refs=${JSON.stringify(r.sourceRefs)}`);
  }
  // 卫生不合格的样本不入库；但「有样本被剔除」绝不能静默——它正是验收项（专名 0 残留）的反面证据
  for (const bad of r.rejected) console.error(`[samples] ⚠ 剔除：${bad.title}（${bad.problems.join(',')}）`);
  if (r.hygiene.rejected > 0 || r.hygiene.kept === 0) process.exitCode = 1;
}

// ---- l5：卡片产出（第 5 步；实现见 tools/distill/l5.js）----

async function runL5Cmd(root, args) {
  if (!root || !args.author) {
    console.error('用法: node tools/distill.js l5 <语料根> --author X [--contrast 同题材作者] [--pack 卡名]');
    console.error('      [--provider stepfun|agnes] [--model ID] [--timeout ms] [--dry-run]');
    console.error('  --dry-run  只做分档与人设转译，不写库');
    process.exit(1);
  }
  const dbFile = process.env.NOVEL_DB_FILE;
  if (!dbFile) {
    console.error('拒绝执行：写库命令必须显式 NOVEL_DB_FILE=<临时库或指定库路径>。');
    process.exit(1);
  }
  console.log(`[distill] 目标库: ${dbFile}`);
  const db = require('../server/db');
  await db.init({});
  const run = require('./distill/l5').runL5;
  const r = await run({
    corpusRoot: root,
    author: args.author,
    contrastAuthor: args.contrast || undefined,
    packName: args.pack || undefined,
    db: db,
    log: (m) => console.log(m),
    provider: args.provider || 'stepfun',
    model: args.model || undefined,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
    write: args['dry-run'] !== true,   // 布尔开关语义见 tools/distill/args.js
  });
  const must = r.rules.filter((x) => x.severity === 'must');
  const tech = r.rules.filter((x) => x.severity !== 'must');
  console.log(`[l5] ${r.author}：硬线 ${must.length} 条｜技法 ${tech.length} 条｜超上限丢弃 ${r.dropped.length}｜不达标排除 ${r.excluded.length}`);
  console.log(`[l5] 排除构成：${JSON.stringify(r.excluded.reduce((a, x) => { a[x.why] = (a[x.why] || 0) + 1; return a; }, {}))}`);
  console.log(`[l5] 冲突簇 ${r.conflicts.length} 条不进卡（人工裁决清单见 l3/conflicts.jsonl）`);
  if (r.downgraded && r.downgraded.length) {
    // 误标冲突会把整簇丢掉、甚至让整张卡 0 条规则——「降档进卡」这件事必须显式可见
    console.log(`[l5] 其中 ${r.downgraded.length} 条标注了 conflict 但措辞看不出方向对立 → 按技法进卡，待人工复核：`);
    for (const d of r.downgraded) console.log(`      · [${d.dim}] ${String(d.trait).slice(0, 60)}`);
  }
  console.log(`[l5] 人设（${r.personaFallback ? '代码兜底' : 'LLM 转译'}，尝试 ${r.personaAttempts} 次）：`);
  for (const line of String(r.persona).split(String.fromCharCode(10))) console.log(`      ${line}`);
  console.log(`[l5] 指纹七行：${JSON.stringify(r.profile)}`);
  if (args['dry-run'] !== true) {
    console.log(`[l5] 卡 #${r.packId}「${r.packName}」：写入规则 ${r.writtenRules} 条（覆盖旧 ${r.deletedRules} 条）`);
  }
  // 一条规则都产不出说明闸门/映射有问题，不能让脚本化调用以为成功
  if (!must.length && !tech.length) process.exitCode = 1;
}

main().catch(err => { console.error('[distill] 失败:', err); process.exit(1); });
