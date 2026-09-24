'use strict';
/**
 * L3 树状 reduce（LLM 环节）：把海量单块观测合并成「同维度内的候选特质簇」。
 *
 * —— 为什么必须有这一步（2026-09-13 首轮闸门实跑暴露）——
 * 首版把闸门 1（复现：≥2 作品或 ≥8 块）直接跑在「同 marker 分组」上，结果晚棠未开
 * 1,611 条观测 → 1,434 个分组，只有 8 组通过（0.5%）。原因是模型的 marker 大多**一次一写**
 * （同一件事换个说法就是另一个 marker），字面相等根本不是「同一特质」的判据。
 * 设计 §3.3 的本意是**语义**同一：「同一特质≥2 作品/≥8 块被独立观察到」。
 * 故把顺序定为：闸门 3/4（逐条，精确）→ **树状 reduce（语义合并）** → 闸门 1/2（在簇上做）。
 *
 * —— 设计要点 ——
 * ① **LLM 只做合并，计数由代码做**：模型输出每条簇的成员 id 列表，支撑（作品数/块数/字数）
 *    由代码按 id 回溯到原始条目算——因为「模型自报计数不可信」正是闸门 3 存在的理由。
 * ② **扇入 8 的平衡树**（设计 §3.3），每层输入 ≤25k token、输出 ≤2k token（叶层放宽到 2.5k，
 *    因为叶层要列 id）。
 * ③ **静默截断防护**（评审硬要求）：输入超预算 → 代码先切批；输出被截断（finish_reason=length）
 *    → 抛 e.truncated 走「一分为二重算」；模型丢掉的条目必须在 `dropped` 里申报；代码侧再核对
 *    **id 覆盖率**（traits ∪ dropped 必须覆盖全部输入 id），未覆盖的 id 一律登记，不许消失。
 * ④ **冲突不静默取一**：同一簇内互相矛盾的写法 → 合并为一条 `conflict: true` 的簇并保留
 *    `variants`，供人工裁决；conflict 条数就是人工裁决量。
 * ⑤ 断点续算：每个节点的结果按 `sha256(层|维度|排序后的输入 id)` 落缓存，重跑免费。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const map = require('./map');
const llm = require('./llm');
const util = require('./util');

const REPO_ROOT = path.resolve(__dirname, '../..');

const FAN_IN = 8;                  // 扇入（设计 §3.3）
const LEAF_MAX_ITEMS = 150;        // 叶层每批条目上限
const LEAF_MAX_TOKENS = 18000;     // 叶层每批 token 上限（给系统提示词与输出留余量）
const NODE_MAX_TOKENS_IN = 25000;  // 单次调用输入上限（设计 §3.3）
const NODE_MAX_TOKENS_OUT = 2000;  // 每层输出上限（叶层 2500，见 §3.3 与 id 列表开销）
const TRAIT_MAX_CP = 80;           // 与 map.js 同口径
const MIN_COVERAGE = 0.8;          // 覆盖率低于此值判模型失职 → 重试
const MAX_SPLIT_DEPTH = 2;         // 输出被截断时「一分为二」的最大递归深度
// 输入超预算时的分裂深度上限：比截断更宽松——它是确定性切分（只切输入、不重算输出），
// 且必须能把「8 个子节点 × 各 40 簇」这类上层组一路切到预算内，否则整个 L3 会零簇收场。
const MAX_SPLIT_DEPTH_BUDGET = 6;

/**
 * 提示词版本号——**改了 SYSTEM_PROMPT 或校验口径就必须 +1**。
 *
 * 它进缓存键（见 mergeCall）：缓存原本只按「层|维度|输入 id 集合」索引，提示词改了
 * 而输入没变时会命中旧缓存，等于改了提示词却拿不到新结果，且没有任何提示
 * （2026-09-13 记录下来：这正是「改了提示词必须清缓存」这条手工纪律的由来）。
 */
const PROMPT_VERSION = 'v2-20260913';

/** 保守的 token 估算（CJK 场景字符/token ≈1.2；只用于切批与超限防护，不用于计费）。 */
function estimateTokens(s) {
  return Math.ceil(util.codePoints(s) / 1.2);
}

const DIM_SET = new Set(map.DIMS);

const SYSTEM_PROMPT = [
  '你是一位文体测量员，负责把多组「写作风格观测」合并去重。',
  '规则：',
  `1. 只在**同一维度内**合并；七个维度是：${map.DIMS.join('、')}。`,
  '2. 语义相同的条目合并成一条：用一句更准确的话概括（≤80 字），必须可证伪（能被计数或找到反例）。',
  '2b. **一条 trait 只写一个可证伪的说法**。同一维度里的**不同侧面**（如「口语词多」与「有重复用词习惯」）',
  '    要**各自成条**，不要塞进一句话——合并成一条大杂烩会同时丢掉两条的可核对性。',
  '3. **必须申报每个输入 id 的去向**：每条输出 trait 用 ids 列出它吸收了哪些输入 id；',
  '   被丢弃的 id 放进 dropped 数组并给出原因（vague 空话/plot 情节摘要/dup 重复/unclear 说不清）。',
  '   一个 id 不许既不在 traits 也不在 dropped 里。ids **原样抄**输入给的编号（如 i12），不要改写、不要编新号。',
  '4. conflict 只用于**真正的互相否定**：同一维度出现方向相反的说法（「极少用省略号」vs「大量用省略号」、',
  '   「不用分号」vs「常用分号」）才置 "conflict": true，并在 variants 里并列两种写法。',
  '   **不同侧面并存不是冲突**（「多用口语词」+「有重复用词习惯」= 两条，都不是冲突）；',
  '   把不矛盾的条目标成 conflict 会让整簇在出卡阶段被整条丢掉。',
  '5. markers 填这条簇里出现过的可计数标记，**最多 5 个**（挑最有代表性的，原样抄，如「……」「立刻」）；没有就留空数组。',
  '6. 禁止情节摘要（不写人物/事件/设定），禁止「文笔优美」这类不可证伪表述。',
  '7. 禁止把**掩码造成的文本现象**当风格：占位符〔人名〕〔地名〕〔势力〕〔功法〕是预处理产物，不是作者的用词习惯；',
  '   「占位符/方括号/专名被统一替换」这类条目不算观测，直接进 dropped。',
  '8. 禁止凭感觉报比例：不要写「占比≥40%」「超过30%」这类**无法在这份输入里核对**的量化断言；',
  '   要量化就写能逐条复核的结构特征（如「每条对话后紧跟动作描写」）。',
  '9. 字符串里**不得出现未转义的双引号**——需要引用标点或对白时用中文引号（「」“”）或直接省去引号，',
  '   否则整个响应会解析失败。',
  '',
  '输出格式：只输出一个 JSON 对象：',
  '{"traits":[{"trait":"…","dim":"…","ids":["…"],"markers":["…"],"conflict":false,"variants":[],"note":""}],',
  ' "dropped":[{"ids":["…"],"reason":"vague"}]}',
  '不要 markdown 代码块，不要解释文字。',
].join('\n');

/** 掩码产物措辞：提到「占位符/方括号」的条目是预处理痕迹，不是作者风格（探针实测出现过一条）。 */
const MASK_ARTIFACT_RE = /占位符|方括号/;
/** 语料级比例断言（无法在这份输入内核对）：「占比」「百分比」「≥40%」。 */
const QUANT_CLAIM_RE = /占比|百分比|\d+(?:\.\d+)?\s*%|比例(?:达|超过|超)/;
/** 每条簇最多保留几个 marker 参与 lift 取最大值（marker 越多越容易撞上噪声取到高 lift）。 */
const MARKER_CAP = 5;

/** 纠正文段：上一次输出没申报这些 id，重试时点名要它补（比原样重打有效，2026-09-13 实测）。 */
function buildCorrection(feedback) {
  if (!feedback || !feedback.length) return [];
  return [
    '',
    `【上次输出的问题】以下 id 你既没放进 traits 的 ids、也没放进 dropped：${feedback.join(', ')}。`,
    '请重新输出完整 JSON：每个 id 都必须有去向（归入某条 trait，或进 dropped 并给出原因）。',
  ];
}

/** 叶层用户消息：逐条列出「id ｜ 维度 ｜ marker ｜ trait ｜ 出现次数」。 */
function buildLeafPrompt(batch, author, feedback) {
  const lines = batch.map((it) => `- id=${it.id} ｜ ${it.dim} ｜ marker=${it.marker || '（无）'} ｜ ${it.trait} ｜ count=${it.count}`);
  return [
    `【作者】${author}`,
    `【任务】把下面 ${batch.length} 条观测按维度合并去重（同一维度内合并，语义相同才合并）。`,
    '====== 观测开始 ======',
    ...lines,
    '====== 观测结束 ======',
    ...buildCorrection(feedback),
    '现在只输出那一个 JSON 对象。',
  ].join('\n');
}

/** 上层节点用户消息：子节点已合并过的簇（含各自 ids / markers / conflict）。 */
function buildNodePrompt(node, author, feedback) {
  const lines = [];
  for (const child of node.children) {
    lines.push(`【簇组 ${child.nodeKey.slice(0, 8)}】`);
    for (const t of child.traits) {
      lines.push(`- ids=${t.ids.join(',')} ｜ ${t.dim} ｜ marker=${(t.markers || []).join('/') || '（无）'} ｜ ${t.trait}` +
        `${t.conflict ? ' ｜ （已标记冲突）' : ''}`);
    }
  }
  return [
    `【作者】${author}`,
    '【任务】下面是同一维度的若干簇，把它们继续合并去重（语义相同才合并；互补的细节可以并进同一条）。',
    '====== 簇开始 ======',
    ...lines,
    '====== 簇结束 ======',
    ...buildCorrection(feedback),
    '现在只输出那一个 JSON 对象。',
  ].join('\n');
}

/** 叶层批分组：按维度切，再按条目数与 **token 预算** 切批（纯函数，可单测）。 */
function leafBatches(items, opts = {}) {
  const maxItems = Number.isInteger(opts.maxItems) ? opts.maxItems : LEAF_MAX_ITEMS;
  const maxTokens = Number.isInteger(opts.maxTokens) ? opts.maxTokens : LEAF_MAX_TOKENS;
  const byDim = new Map();
  for (const it of items) {
    if (!byDim.has(it.dim)) byDim.set(it.dim, []);
    byDim.get(it.dim).push(it);
  }
  const out = [];
  for (const [dim, list] of byDim) {
    let cur = [];
    let tokens = 0;
    for (const it of list) {
      // 每行开销 ≈「- id=i123 ｜ 维度 ｜ marker= ｜ ｜ count=」+ 分隔符 ≈ 15 token
      const c = estimateTokens(`${it.trait}${it.marker || ''}`) + 15;
      if (cur.length && (cur.length >= maxItems || tokens + c > maxTokens)) {
        out.push({ dim: dim, items: cur });
        cur = [];
        tokens = 0;
      }
      cur.push(it);
      tokens += c;
    }
    if (cur.length) out.push({ dim: dim, items: cur });
  }
  out.sort((a, b) => (a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : 0));
  return out;
}

/** 把同维度的节点按扇入 8 分组（纯函数）。 */
function groupNodes(nodes, fanIn = FAN_IN) {
  const groups = [];
  for (let i = 0; i < nodes.length; i += fanIn) groups.push(nodes.slice(i, i + fanIn));
  return groups;
}

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * id 归一化：模型偶尔把 `i12` 写成 `12` / `#12` / `id=12`（探针实测 34 条里有 10 条被写成别的样式，
 * 直接把覆盖率打到 70.6%）。这里只做「等价改写」的容忍，不做模糊匹配——编出来的新号仍然算未知 id。
 */
function normalizeId(id) {
  const s = String(id == null ? '' : id).trim().replace(/^#/, '').replace(/^id\s*=\s*/i, '');
  return /^\d+$/.test(s) ? `i${s}` : s;
}

/** 解析模型输出并做代码侧校验（ids 归属、维度白名单、trait 长度、覆盖率）。 */
function validateMerge(parsed, allowedIds, dimOf, opts = {}) {
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : MIN_COVERAGE;
  const traits = [];
  const dropped = [];
  const problems = { unknownId: 0, dimMismatch: 0, traitTooLong: 0, traitEmpty: 0, uncovered: 0, maskArtifact: 0, quantClaim: 0 };
  const seen = new Set();
  const list = parsed && Array.isArray(parsed.traits) ? parsed.traits : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const trait = typeof raw.trait === 'string' ? raw.trait.trim() : '';
    const dim = typeof raw.dim === 'string' ? raw.dim.trim() : '';
    const ids = (Array.isArray(raw.ids) ? raw.ids : []).map(normalizeId);
    // 卫生两条：掩码痕迹（预处理产物，不是作者风格）与语料级比例断言（在这份输入里无法核对）。
    // 判死的条目仍要**申报 id 去向**（进 dropped），否则它们会掉进 uncovered 变成「静默丢失」。
    if (trait && (MASK_ARTIFACT_RE.test(trait) || QUANT_CLAIM_RE.test(trait))) {
      const reason = MASK_ARTIFACT_RE.test(trait) ? 'mask-artifact' : 'quant-claim';
      if (reason === 'mask-artifact') problems.maskArtifact++; else problems.quantClaim++;
      const okIds = ids.filter((id) => allowedIds.has(id)).filter((id) => { if (dimOf(id) !== dim) { problems.unknownId++; return false; } return true; });
      for (const id of okIds) seen.add(id);
      if (okIds.length) dropped.push({ ids: okIds, reason: reason, stage: 'code', trait: trait });
      continue;
    }
    if (!trait) { problems.traitEmpty++; continue; }
    if (util.codePoints(trait) > TRAIT_MAX_CP) { problems.traitTooLong++; continue; }
    if (!DIM_SET.has(dim)) { problems.dimMismatch++; continue; }
    const keptIds = ids.filter((id) => {
      const ok = allowedIds.has(id) && dimOf(id) === dim;
      if (!ok) problems.unknownId++;
      return ok;
    });
    if (!keptIds.length) continue;
    for (const id of keptIds) seen.add(id);
    traits.push({
      trait: trait, dim: dim, ids: keptIds,
      markers: (Array.isArray(raw.markers) ? raw.markers : [])
        .filter((m) => typeof m === 'string' && m.trim() && !MASK_ARTIFACT_RE.test(m))
        .map((m) => m.trim()).slice(0, MARKER_CAP),
      conflict: raw.conflict === true,
      variants: Array.isArray(raw.variants) ? raw.variants.filter((v) => typeof v === 'string') : [],
      nodeKey: null,
    });
  }
  for (const raw of (parsed && Array.isArray(parsed.dropped) ? parsed.dropped : [])) {
    const ids = (Array.isArray(raw && raw.ids) ? raw.ids : []).map(normalizeId).filter((id) => {
      const ok = allowedIds.has(id);
      if (!ok) problems.unknownId++;
      return ok;
    });
    for (const id of ids) seen.add(id);
    if (ids.length) dropped.push({ ids: ids, reason: (raw && raw.reason) || 'unspecified', stage: 'model' });
  }
  const uncovered = [...allowedIds].filter((id) => !seen.has(id));
  problems.uncovered = uncovered.length;
  const coverage = allowedIds.size ? (allowedIds.size - uncovered.length) / allowedIds.size : 1;
  return { traits: traits, dropped: dropped, problems: problems, uncovered: uncovered, coverage: coverage, minCoverage: minCoverage };
}

/**
 * 逐层合并。节点 = {nodeKey, dim, ids:Set, traits:[], dropped:[], children:[]}。
 * @param {{leafNodes:Array, opts:Object, ctx:Object, log:Function}} o
 */
async function reduceTree({ leafNodes, opts = {}, ctx, log }) {
  const levelStats = [];
  const allDropped = [];
  const allProblems = { unknownId: 0, dimMismatch: 0, traitTooLong: 0, traitEmpty: 0, uncovered: 0 };
  let nodes = leafNodes.slice();
  let level = 0;
  const fanIn = opts.fanIn || FAN_IN;
  // ★ 叶层必须**每批一次调用**（不是按扇入把 8 个叶批合成一次）：
  //   叶批本身就是「一次调用能装下的量」，再乘以扇入必然超输入预算（25k token）——
  //   2026-09-13 首轮实跑就是这么把两个 1,200 条的巨批送进去、双双失败、产出 0 簇的。
  //   扇入只在**合并后的节点**之间生效（level ≥ 1）。
  let grouped = nodes.map((n) => [n]);
  while (grouped.length) {
    const t0 = Date.now();
    let calls = 0;
    const usage = { input: 0, output: 0 };
    const results = await map.runPool(grouped.map((group) => async () => {
      const node = await mergeNode({ group: group, level: level, opts: opts, ctx: ctx, log: log });
      calls++;
      usage.input += node.usage.input;
      usage.output += node.usage.output;
      return node;
    }), { concurrency: opts.concurrency || 6, retry: opts.retry, baseDelayMs: opts.baseDelayMs });
    const next = [];
    let failed = 0;
    let degradedGroups = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.ok) {
        failed++;
        log(`[reduce] L${level} 组 ${i} 失败：${r.error && r.error.message}`);
        // 失败节点的条目必须先算出来——两条去向都要用它（降级放回 / 登记丢弃）
        const ids = [...grouped[i].reduce((s, n) => { for (const id of n.ids) s.add(id); return s; }, new Set())];
        // ★ 单组降级（2026-09-13 加）：把这一组的**输入节点**原样放回 `next` 继续往上走。
        //   它们本来就有 traits + ids（是上一层成功合并的产物），所以该组的 id 仍然进簇——
        //   只是没有再被合并一次（更碎、每簇支撑更小，末端的闸门 1/2 会照常筛）。
        //   这比「整组登记进 dropped」强一个量级：`reduce-call-failed` 只保证「不静默」，
        //   而这里是**不丢**。叶层不适用（叶节点 traits 为空，放回等于没有簇）→ 那时才登记丢弃。
        //   降级节点打 `degraded` 标记并在下一轮**排除出分组**，否则同一组会被反复重试到死循环。
        const fallback = grouped[i].filter((n) => (n.traits || []).length > 0);
        if (fallback.length) {
          for (const n of fallback) { n.degraded = true; next.push(n); }
          degradedGroups++;
        } else {
          allDropped.push({ ids: ids, reason: 'reduce-call-failed', stage: 'code' });
        }
        continue;
      }
      next.push(r.value);
      for (const d of r.value.dropped) allDropped.push(d);
      for (const k of Object.keys(allProblems)) allProblems[k] += (r.value.problems[k] || 0);
    }
    levelStats.push({
      level: level, nodesIn: nodes.length, calls: grouped.length, failed: failed,
      degradedGroups: degradedGroups,
      nodesOut: next.length, wallMs: Date.now() - t0, usage: usage,
      traits: next.reduce((s, n) => s + n.traits.length, 0),
      dropped: next.reduce((s, n) => s + n.dropped.length, 0),
    });
    if (degradedGroups) {
      log(`[reduce] ⚠ L${level} 有 ${degradedGroups}/${grouped.length} 组失败 → 这 ${degradedGroups} 组**降级**为输入节点继续上走` +
        `（条目不丢，只是少合并一层；已登记 summary.reduce.levels[${level}].degradedGroups）`);
    }
    log(`[reduce] L${level}: ${nodes.length} 节点 → ${grouped.length} 次调用（失败 ${failed}）→ ${next.length} 节点，` +
      `${levelStats[level].traits} 条簇，token ${usage.input}/${usage.output}，${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (next.length === 0) {
      // 整层全败且没有一个节点带 traits（= 叶层全败）：没有可降级的簇集，维持空返回。
      // 非叶层的整层失败现在已经被「单组降级」兜住（next 不可能为空），这里只是安全网。
      log(`[reduce] ⚠⚠ L${level} 整层失败（${failed} 组）且无可降级节点 → 本轮簇集为空`);
      return { nodes: [], levels: levelStats, dropped: allDropped, problems: allProblems,
        failedCalls: levelStats.reduce((s, l) => s + l.failed, 0), degradedAt: level };
    }
    nodes = next;
    level++;
    if (nodes.length <= 1) break;
    // 降级节点（degraded）**不再参与分组**：它们所在的那一组刚刚合并失败，再拿去重试同一组
    // 只会重复失败、并让层数无限增长。它们随 `nodes` 一起进最终簇集（直通，不再调用 LLM）。
    const groupable = nodes.filter((n) => !n.degraded);
    if (!groupable.length) break;
    grouped = groupNodes(groupable, fanIn);   // 上一层：扇入 8 合并（只合并没降级的）
  }
  return { nodes: nodes, levels: levelStats, dropped: allDropped, problems: allProblems, failedCalls: levelStats.reduce((s, l) => s + l.failed, 0) };
}

/** 把若干节点合成一个逻辑节点（截断拆分后使用）：ids/traits/dropped 取并集，usage 相加。 */
function combineNodes(nodes, level, dim) {
  const ids = new Set();
  const traits = [];
  const dropped = [];
  const problems = { unknownId: 0, dimMismatch: 0, traitTooLong: 0, traitEmpty: 0, uncovered: 0, maskArtifact: 0, quantClaim: 0 };
  const usage = { input: 0, output: 0 };
  const children = [];
  for (const n of nodes) {
    for (const id of n.ids) ids.add(id);
    for (const t of n.traits) traits.push(t);
    for (const d of n.dropped) dropped.push(d);
    for (const k of Object.keys(problems)) problems[k] += (n.problems && n.problems[k]) || 0;
    usage.input += (n.usage && n.usage.input) || 0;
    usage.output += (n.usage && n.usage.output) || 0;
    children.push({ nodeKey: n.nodeKey, traits: n.traits, dim: n.dim });
  }
  const covered = new Set();
  for (const t of traits) for (const id of t.ids) covered.add(id);
  for (const d of dropped) for (const id of d.ids) covered.add(id);
  const uncovered = [...ids].filter((id) => !covered.has(id));
  problems.uncovered = uncovered.length;
  if (uncovered.length) dropped.push({ ids: uncovered, reason: 'uncovered-by-model', stage: 'code' });
  return {
    nodeKey: sha(`split|${level}|${dim}|${[...ids].sort().join(',')}`),
    level: level, dim: dim, ids: ids, traits: traits, dropped: dropped,
    problems: problems, coverage: ids.size ? (ids.size - uncovered.length) / ids.size : 1,
    uncovered: uncovered, usage: usage, children: children,
  };
}

/** 把一个节点一分为二（截断重算用）：叶节点按 items 切，非叶节点按 traits 切。 */
function splitNode(node) {
  const half = (arr) => [arr.slice(0, Math.ceil(arr.length / 2)), arr.slice(Math.ceil(arr.length / 2))];
  if (node.items) {
    const [a, b] = half(node.items);
    const mk = (items, tag) => ({
      nodeKey: sha(`leafsplit|${node.dim}|${tag}|${items.map((i) => i.id).join(',')}`),
      level: node.level, dim: node.dim, items: items, ids: new Set(items.map((i) => i.id)),
      traits: [], dropped: [], problems: {}, _leaf: true, from: node.nodeKey,
    });
    return [mk(a, 'a'), mk(b, 'b')];
  }
  const [ta, tb] = half(node.traits || []);
  const mkT = (traits, tag) => {
    const ids = new Set();
    for (const t of traits) for (const id of t.ids) ids.add(id);
    return {
      nodeKey: sha(`nodesplit|${node.dim}|${tag}|${[...ids].join(',')}`),
      level: node.level, dim: node.dim, traits: traits, ids: ids, dropped: [], problems: {},
      from: node.nodeKey,
    };
  };
  return [mkT(ta, 'a'), mkT(tb, 'b')];
}

/**
 * 单节点合并调用（含缓存、超预算/截断拆分、覆盖率重试）。
 *
 * 两条拆分触发条件，拆法相同、成因不同：
 *   · `truncated`（输出被截断）——模型写不完；
 *   · `overBudget`（输入超预算）——**上层节点特有**：叶层有 leafBatches 卡住每批 ≤18000 token，
 *     但非叶层的输入是子节点合并后的簇，没有任何东西卡它。2026-09-13 实测：白石 8,287 条观测
 *     跑到 L1/L2，节点输入超 25000 token 直接抛 overBudget（nonRetryable），没有恢复路径
 *     → 6 次调用失败 → 顶层 0 簇、整轮 L3 白跑（summary.ok=false 是唯一线索）。
 *     这里给超预算走同一套「一分为二再合并」，并允许更深的分裂（深度只影响切分次数，不丢数据）。
 */
async function mergeNode({ group, level, opts, ctx, log, depth = 0, budgetDepth = 0 }) {
  try {
    return await mergeCall({ group: group, level: level, opts: opts, ctx: ctx, log: log });
  } catch (e) {
    const splittable = group.length > 1 || (group[0].items ? group[0].items.length > 1 : (group[0].traits || []).length > 1);
    const v = splitVerdict(e, depth, budgetDepth, splittable);
    if (v.canSplit) {
      const budgetSplit = v.budget;
      const parts = group.length > 1
        ? (() => { const h = Math.ceil(group.length / 2); return [group.slice(0, h), group.slice(h)]; })()
        : splitNode(group[0]).map((n) => [n]);
      log(`[reduce] L${level} ${group[0].dim} ${budgetSplit ? '输入超预算' : '输出截断'} → 拆分为 ` +
        `${parts.map((p) => (p[0].items ? p[0].items.length + '条' : (p[0].traits || []).length + '簇')).join(' + ')} 重算` +
        `（预算第 ${budgetDepth} 刀 / 截断第 ${depth} 刀）`);
      const parentIds = group.reduce((s, n) => { for (const id of n.ids) s.add(id); return s; }, new Set());
      const nodes = [];
      for (const p of parts) {
        nodes.push(await mergeNode({ group: p, level: level, opts: opts, ctx: ctx, log: log,
          depth: v.nextDepth, budgetDepth: v.nextBudgetDepth }));
      }
      const combined = combineNodes(nodes, level, group[0].dim);
      // 不变式：拆分不得让任何 id 消失（combineNodes 只看子节点，父节点独有的 id 要在这里登记）
      const lost = [...parentIds].filter((id) => !combined.ids.has(id));
      if (lost.length) combined.dropped.push({ ids: lost, reason: 'split-unaccounted', stage: 'code' });
      return combined;
    }
    throw e;
  }
}

/**
 * 拆分判决（纯函数）——**两个成因各自计数**（2026-09-13 修）。
 *
 * 原实现共用一个 `depth`，于是「先把输入按预算切几刀」会把「输出被截断还能再切几刀」的额度吃光。
 * 白石与青崖的 L2 先后正是这么死的：预算切到第 2~3 层后，模型对剩下的节点思考吃满 32k
 * （content 空 + finish_reason=length），此时 depth 已 ≥ MAX_SPLIT_DEPTH → 不切 → 整层 0 节点
 * → **整轮 0 簇**（两个最大的作者各白跑一次，第二次是 2026-09-13 20:43 的青崖）。
 *
 * 为什么会这样：输入越大，模型的思考越长；「输入超预算」与「思考吃满输出预算」是**同一个病
 * （东西太大）的两种表现**，所以两种拆分都该按「切了多少刀」独立记账——预算刀最多 6 刀、
 * 截断刀最多 2 刀，各自封顶（总深度 ≤ 8，不至于指数爆炸）。
 */
function splitVerdict(err, depth, budgetDepth, splittable) {
  const budget = !!(err && err.overBudget);
  const used = budget ? budgetDepth : depth;
  const cap = budget ? MAX_SPLIT_DEPTH_BUDGET : MAX_SPLIT_DEPTH;
  const canSplit = !!(err && (err.truncated || err.overBudget)) && used < cap && !!splittable;
  return {
    canSplit: canSplit, budget: budget,
    nextDepth: depth + (canSplit && !budget ? 1 : 0),
    nextBudgetDepth: budgetDepth + (canSplit && budget ? 1 : 0),
  };
}

/** 单次合并调用（缓存 + 校验 + 覆盖率重试）。 */
async function mergeCall({ group, level, opts, ctx, log }) {
  const dim = group[0].dim;
  const ids = group.reduce((s, n) => { for (const id of n.ids) s.add(id); return s; }, new Set());
  const nodeKey = sha(`${PROMPT_VERSION}|${level}|${dim}|${[...ids].sort().join(',')}`);
  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, `${nodeKey}.json`) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      c.ids = new Set(c.ids);   // 缓存里是数组，用前必须还原成 Set（validateMerge/dimOfId 全按 Set 语义）
      return c;
    } catch { /* 缓存坏了就重算 */ }
  }
  const buildPrompt = (feedback) => {
    if (group[0].items) {
      // 叶层：直接列原始条目
      return buildLeafPrompt(group.flatMap((n) => n.items), ctx.author, feedback);
    }
    return buildNodePrompt({ children: group }, ctx.author, feedback);
  };
  const attempts = Number.isInteger(opts.coverageRetry) ? opts.coverageRetry : 1;
  let last = null;
  let feedback = null;   // 上一次没申报的 id（纠正式重试的输入）
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const prompt = buildPrompt(feedback);
    const est = estimateTokens(prompt);
    const maxIn = Number.isInteger(opts.maxInputTokens) ? opts.maxInputTokens : NODE_MAX_TOKENS_IN;
    if (est > maxIn) {
      // 输入超预算：不静默截断，也不重试（重试同样的输入只会再超一次）——
      // 抛 overBudget 交给 mergeNode 一分为二（叶层则由 leafBatches 提前卡住）
      const e = new Error(`reduce 输入超预算：${est} token > ${maxIn}（维度 ${dim}，id ${ids.size} 个）`);
      e.overBudget = true;
      e.nonRetryable = true;   // 确定性错误：重试同样的输入只会再超一次
      throw e;
    }
    const body = map.buildBody({
      provider: ctx.provider, model: ctx.model, maxTokens: opts.maxTokens || map.MAX_TOKENS,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    });
    const res = await llm.chatJson({ apiKey: ctx.nextKey ? ctx.nextKey() : ctx.apiKey, body, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs, provider: ctx.provider });
    const parsed = map.extractJson(res.content);
    const usage = { input: (res.usage && res.usage.prompt_tokens) || 0, output: (res.usage && res.usage.completion_tokens) || 0 };
    if (parsed === null) {
      const e = new Error(`reduce 内容无法解析为 JSON（finish_reason=${res.finishReason || '?'}）`);
      if (res.finishReason === 'length') e.truncated = true;
      e.usage = usage;
      e.nodeKey = nodeKey;
      last = e;
      continue;
    }
    const v = validateMerge(parsed, ids, (id) => dimOfId(group, id), opts);
    if (res.finishReason === 'length') {
      // 输出被截断：即使能解析出来也不可信（尾部的 ids 可能整段丢了）→ 当失败重试
      const e = new Error(`reduce 输出被截断（finish_reason=length，维度 ${dim}）`);
      e.truncated = true;
      e.usage = usage;
      e.nodeKey = nodeKey;
      last = e;
      continue;
    }
    if (v.coverage < v.minCoverage && attempt < attempts) {
      // 低覆盖是**模型漏申报**，不是网络问题：重打同样的输入不如点名要它补（纠正文段）
      log(`[reduce] L${level} ${dim} 覆盖率 ${(100 * v.coverage).toFixed(1)}% < ${(100 * v.minCoverage).toFixed(0)}%，` +
        `点名 ${v.uncovered.length} 个未申报 id 后重试`);
      if (cacheFile) {
        // 失败样本落盘留痕（覆盖率问题此前只能靠日志猜）
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(path.join(path.dirname(cacheFile), `coverage-fail-${nodeKey}-a${attempt}.txt`), String(res.content || ''), 'utf8');
        } catch { /* 落盘失败不影响主流程 */ }
      }
      feedback = v.uncovered.slice(0, 40);
      last = new Error(`覆盖率不足 ${(100 * v.coverage).toFixed(1)}%`);
      continue;
    }
    const node = {
      nodeKey: nodeKey, level: level, dim: dim, ids: ids, traits: v.traits, dropped: v.dropped,
      problems: v.problems, coverage: v.coverage, uncovered: v.uncovered, usage: usage,
      children: group.map((n) => ({ nodeKey: n.nodeKey, traits: n.traits, dim: n.dim })),
    };
    if (v.uncovered.length) {
      // 未覆盖的 id：登记（不许消失），并从后续合并里剔除（它们的簇信息已经丢了）
      node.dropped = node.dropped.concat([{ ids: v.uncovered, reason: 'uncovered-by-model', stage: 'code' }]);
    }
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ ...node, ids: [...node.ids], children: node.children }));
    }
    return node;
  }
  throw last || new Error('reduce 合并失败');
}

/** 取某 id 在组内的维度（校验模型没把条目塞进别的维度）。 */
function dimOfId(group, id) {
  for (const n of group) {
    if (n.items) {
      const hit = n.items.find((it) => it.id === id);
      if (hit) return hit.dim;
    }
    for (const t of n.traits || []) if (t.ids && t.ids.includes(id)) return t.dim;
  }
  return null;
}

/**
 * 合并结果 → 候选簇（含**代码侧**支撑统计）。
 * 支撑一律从 `idToItem` 回溯原始条目算：作品数 / 块数 / 字数 / 各档 countCheck 计数 / marker 集合。
 */
function finalizeClusters(nodes, idToItem, opts = {}) {
  const disabled = opts.disabledWorks instanceof Set ? opts.disabledWorks : new Set(opts.disabledWorks || []);
  const out = [];
  for (const node of nodes) {
    for (const t of node.traits) {
      const items = t.ids.map((id) => idToItem.get(id)).filter(Boolean);
      const works = new Set();
      const blocks = new Set();
      let advisoryBlocks = 0;
      const markers = new Map();   // marker → 条目数
      const checks = { ok: 0, unverifiable: 0, mismatch: 0 };
      for (const it of items) {
        if (it.marker) markers.set(it.marker, (markers.get(it.marker) || 0) + 1);
        checks[it.countCheck.status] = (checks[it.countCheck.status] || 0) + 1;
        // 约束 ①：裕度不足的书的块不计入支撑（只留痕），否则等于用噪声块撑复现闸门
        if (disabled.has(it.work)) { advisoryBlocks++; continue; }
        works.add(it.work);
        blocks.add(`${it.work}#${it.chunkIndex}`);
      }
      out.push({
        dim: t.dim, trait: t.trait,
        // marker 上限：按「在该簇条目里出现的频次」取前 MARKER_CAP 个（参与 lift 的 marker 越多，
        // 越容易靠某个偶然 marker 撞上高 lift——这是放宽的通过面，必须收紧）
        markers: (() => {
          const freq = new Map();
          for (const m of markers.keys()) freq.set(m, markers.get(m));
          for (const m of t.markers || []) if (!freq.has(m)) freq.set(m, 0);
          return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, MARKER_CAP);
        })(),
        markerHist: [...markers.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => ({ marker: m, items: c })),
        conflict: t.conflict === true, variants: t.variants || [],
        support: { works: works.size, blocks: blocks.size, chars: blocks.size * util.MAP_CHUNK_SIZE, items: items.length, advisoryBlocks: advisoryBlocks },
        checks: checks,
        items: items.map((it) => ({ id: it.id, trait: it.trait, marker: it.marker, evidence: it.evidence, count: it.count,
          work: it.work, chunkIndex: it.chunkIndex, relaxed: it.relaxed, check: it.countCheck.status })),
      });
    }
  }
  out.sort((a, b) => (b.support.blocks - a.support.blocks) || (a.dim < b.dim ? -1 : 1));
  return out;
}

/** 打 id 到条目上（叶层用；id 全局唯一）。 */
function assignIds(items) {
  const idToItem = new Map();
  const withIds = items.map((it, i) => {
    const id = `i${i}`;
    const rec = { ...it, id: id };
    idToItem.set(id, rec);
    return rec;
  });
  return { withIds: withIds, idToItem: idToItem };
}

function leafNodesOf(batches, opts = {}) {
  return batches.map((b) => ({
    nodeKey: sha(`leaf|${b.dim}|${b.items.map((i) => i.id).join(',')}`),
    level: -1, dim: b.dim,
    ids: new Set(b.items.map((i) => i.id)),
    items: b.items,
    traits: [], dropped: [], problems: {}, _leaf: true,
  }));
}

/**
 * @param {{items:Array, author:string, opts?:Object, log?:Function}} o
 * @returns {Promise<{clusters:Array, levels:Array, dropped:Array, problems:Object, usage:Object, leafNodes:number}>}
 */
async function reduceAuthor(o) {
  const author = o.author;
  // opts 是调用方的对象：不就地改（曾经就地写 cacheDir，导致「传 cacheDir:null 想关缓存」被静默
  // 换回默认路径——单测里真的发生了：后一个用例命中了前一个用例的缓存，LLM 调用数为 0）
  const opts = Object.assign({}, o.opts || {});
  const log = o.log || (() => {});
  const { withIds, idToItem } = assignIds(o.items);
  const batches = leafBatches(withIds, opts);
  const leafNodes = leafNodesOf(batches);
  const provider = llm.providerOf(opts.provider || 'agnes');
  const keys = (Array.isArray(opts.apiKeys) && opts.apiKeys.length) ? opts.apiKeys
    : (opts.apiKey ? [opts.apiKey] : (provider.multiKey ? llm.resolveApiKeys(provider.name) : [llm.resolveApiKey()]));
  const ctx = {
    author: author, provider: provider, model: opts.model || provider.defaultModel,
    apiKey: keys[0], nextKey: llm.keyRotator(keys),
    fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || map.DEFAULT_TIMEOUT_MS,
  };
  // cacheDir：undefined = 默认目录；**显式 null = 关闭缓存**（单测与一次性实验都需要「不受污染」的语义）
  opts.cacheDir = opts.cacheDir === null
    ? null
    : (opts.cacheDir || path.join(REPO_ROOT, 'data/corpus', `src-${author}`, 'l3/reduce-cache'));
  const t0 = Date.now();
  const r = await reduceTree({ leafNodes: leafNodes, opts: opts, ctx: ctx, log: log });
  const clusters = finalizeClusters(r.nodes, idToItem, { disabledWorks: opts.disabledWorks });
  const usage = r.levels.reduce((s, l) => ({ input: s.input + l.usage.input, output: s.output + l.usage.output }), { input: 0, output: 0 });
  return {
    clusters: clusters, levels: r.levels, dropped: r.dropped, problems: r.problems,
    failedCalls: r.failedCalls || 0,
    // 降级统计：degradedAt = 整层空（安全网路径）；degradedGroups = 各层「单组降级」之和。
    // 两者都**不丢数据**（失败组的输入节点被原样放回），所以它们不影响 ok，只影响「跑得好不好」。
    degradedAt: Number.isInteger(r.degradedAt) ? r.degradedAt : null,
    degradedGroups: r.levels.reduce((s, l) => s + (l.degradedGroups || 0), 0),
    usage: usage, leafNodes: leafNodes.length, wallMs: Date.now() - t0,
    idToItem: idToItem,
  };
}

module.exports = {
  MASK_ARTIFACT_RE, QUANT_CLAIM_RE, MARKER_CAP, PROMPT_VERSION,
  FAN_IN, LEAF_MAX_ITEMS, LEAF_MAX_TOKENS, MAX_SPLIT_DEPTH, MAX_SPLIT_DEPTH_BUDGET, NODE_MAX_TOKENS_IN, NODE_MAX_TOKENS_OUT, TRAIT_MAX_CP, MIN_COVERAGE,
  SYSTEM_PROMPT, buildLeafPrompt, buildNodePrompt, buildCorrection, leafBatches, groupNodes, validateMerge, normalizeId,
  reduceTree, mergeNode, mergeCall, combineNodes, splitNode, splitVerdict, finalizeClusters, assignIds, leafNodesOf, reduceAuthor, estimateTokens,
};
