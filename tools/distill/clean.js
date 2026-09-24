// 语料清洗（2026-09-13，第 0 步的前置）：剔除盗版站水印/HTML 残留/PUA 乱码/明确广告行。
//
// 为什么必须先清洗再建典：① 章末推广块里会出现**别的书的角色名**（晚棠未开语料实测「陆安」
// 《黎明之劫》），这些词会被 n-gram 统计当成「作者专属专名」收进词典，也会进 map 污染风格特征；
// ② 盗版占位文本（「请升级到新版本查看本章」）与站点 URL 是纯噪声；③ PUA 私用区字符会污染
// 139 维指纹里的标点/字符类特征。
//
// 规则来源：`docs/report/.../20-作家印记蒸馏/08-开源方案调研.md` §A（tickmao/Novel 的 legado
// 净化规则：结构锚 + 关键词 + 行数上限；rockbenben/novel-processor：PUA/HTML；FictionDown AD.md：
// 盗版脏样本分类）。**只转写思路，不复制文件**（上游规则集无 LICENSE）。
//
// ★ 首版规则在真实语料上过度删除，本版按实测样例收紧（这是本文件最重要的一段说明）：
//   首版删掉 0.365% 字符，抽取样例逐条复核发现四类**误删正文**，全部已改：
//   ① 【…】整行包裹 → 误删读者群/游戏公屏/论坛体内容（「【清浅：你怎么？掉线了？】」是小说正文）；
//   ② 短行 + 冒号结尾（≤8 字且无言语动词）→ 误删正常的对话提示语（「许澈沉默：」「清浅更是嗔怪：」）
//      —— 这类行是「对话」维度的风格证据，删掉等于自毁特征；
//   ③ 书名号 + 推荐/收藏 形态 → 误删正文里的读书/观影叙述（言情都市题材里人物常聊书影音）；
//   ④ 「……」/「——」当推广块结构锚 + 宽词典（含「喜欢」）→ 误删场景切换后的正文行
//      （「……」是本书语料的场景分隔符，不是广告框）。
//   收紧原则：**只删「不可能是正文」的行**——站点/域名水印、明确的盗版占位语、HTML/PUA 残留。
//   任何有歧义的形态一律保留（宁可漏删噪声，也不删正文；漏删的后果只是特征里多几个噪声词，
//   误删的后果是风格证据永久缺失）。
//
// 性能纪律：逐行判定、固定窗口（分隔线后 ≤5 行），不做跨行模糊匹配（上游有 O(n²) 冻结事故）。
'use strict';

// PUA 私用区 + 替换符 + 常见控制字符（改成空串：会污染标点/字符类特征）
const RE_JUNK_CHAR = /[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
// HTML 残留（标签 + 实体）
const RE_HTML_TAG = /<\/?(?:br|center|font|div|p|span|a|b|i|u|hr|table|tr|td|img|script|style)\b[^>]*>/gi;
const RE_HTML_ENTITY = /&(?:nbsp|quot|amp|lt|gt|#\d{2,5}|#x[0-9a-f]{2,4});/gi;
// 网址：http(s) / www（含 ω 同形字）/ 带站点后缀的域名
const RE_URL = new RegExp(
  [
    'https?:\\/\\/[^\\s，。；！？）】」]+',
    'w(?:ww|[\\u03c9\\uff57])[.．](?:[\\w\\u03c9\\u03c7\\u03bf\\uff0e．-])+',
    '\\b[a-z0-9-]{2,20}\\s*[.．]\\s*(?:com|net|org|cn|cc|tv|info|xyz|club|top|vip|me)\\b[^\\s，。；！？）】」]*',
  ].join('|'), 'gi');

/** 站点/盗版源水印（出现即「不可能是正文」——真实站点名与域名级标识）。 */
const SITE_WORDS = [
  '速读谷', '笔趣阁', '顶点小说', '顶点手机', '飞速中文', '天籁小说', '棉花糖小说', '书客居', '新笔趣阁',
  '全文字无广告', '全文字小说', '无弹窗', '记住本站', '请记住本书', '首发书站', '请收藏本站', '收藏本站',
  '本站访问地址', '网站最新地址', '当前网址', '访问地址', '最新章节请', '请退出转码', '转码失败',
];
/** 盗版占位/搬运残留（明确的站点话术，不是任何作者会写的正文）。 */
const PIRATE_WORDS = [
  '请升级到新版本', '升级到新版本查看', '检测到你的最新阅读', '检测到阅读记录', '正在手打中', '请稍后刷新',
  '本章节由', '本书由', '本书仅供个人', '本书版权归', '仅供个人学习', '请在下载后', '喜欢请收藏',
  'txt下载', 'TXT下载', '手机用户请', '天才一秒记住', '天才壹秒', '一秒记住本站', '网站即将关闭',
];
const RE_SITE = new RegExp(SITE_WORDS.join('|'));
const RE_PIRATE = new RegExp(PIRATE_WORDS.join('|'));
// 分隔线 /「（本章完）」这类结构锚（—— 与 …… 只用 2 字符；上游规则集用这两种做段锚）
const RE_SEP = /^\s*(?:[—…]{2,}|[\-=＊*_~·]{3,}|[（【〔]?\s*(?:未完待续|本章完|全文完|本章结束|本章终)\s*[）】〕]?)\s*$/;
// 纯符号行（举例：一整行都是 ==== 或 ----，是广告框/分节线，不含任何汉字）
const RE_SYMBOL_LINE = /^\s*[=\-*＊—…_~·﹏]{3,}\s*$/;
// 章末标记单独成行（不是正文；带其他内容的行不算）
const RE_CHAPTER_MARK = /^[（【〔]?\s*(?:本章完|未完待续|全文完|本章结束|本章终|全书完)\s*[）】〕]?[\s。！？!?]*$/;
// 广告框里的推广话术（**只在明确广告框内**才生效；单独出现不删——晚棠未开语料是「写小说」题材，
// 正文里天然会出现「新书/上架/收藏/推荐票/月票」，逐行判定会把正文删光）
const AD_LINES = /求收藏|求推荐票|求月票|求打赏|求订阅|加更|第二更|第三更|新书上传|新书发布|新书期间|推荐一本新书|请大家收藏|感谢大家的支持|作者的话|作者说|码字|存稿/;

/** 行级判定：返回 {action:'drop'|'replace', category, text?} 或 null（保留）。 */
function classifyLine(line) {
  const raw = line;
  let s = raw.replace(RE_HTML_TAG, '').replace(RE_HTML_ENTITY, ' ');
  if (RE_URL.test(s)) {
    const stripped = s.replace(RE_URL, '');
    if (stripped.replace(/[\s：:，。；、]/g, '').length <= 2) return { action: 'drop', category: 'url' };
    s = stripped; // 正文行里夹带的 URL 只剥掉 URL 本身，正文保留
  }
  const compact = s.replace(/\s+/g, '');
  // 站点/盗版话术：命中即删（不设长度门槛——这些字符串本身就是强判据）
  if (RE_SITE.test(compact)) return { action: 'drop', category: 'site' };
  if (RE_PIRATE.test(compact)) return { action: 'drop', category: 'pirate' };
  // 章末标记单独成行（（本章完）/（未完待续）…）——不是正文，删掉；带其他内容的行不碰
  if (RE_CHAPTER_MARK.test(s.trim())) return { action: 'drop', category: 'chapter_mark' };
  if (RE_SYMBOL_LINE.test(s)) return { action: 'drop', category: 'symbol_line' };
  if (s !== raw) return { action: 'replace', category: 'inline', text: s };
  return null;
}

/** 广告框判定：分隔线起头 → 框内（≤5 行）出现站点/盗版话术即为广告框 → 连闭合分隔线一起删。
 *  与首版的区别：首版「逐行见关键词就吃」会把场景分隔符后的正文吃掉；现在要求
 *  **框内必须出现强证据**（站点名/URL/盗版话术），且框不能长于 5 行（长块多半是正文）。 */
function promoBlockEnd(lines, start) {
  const end = Math.min(lines.length, start + 1 + 5 + 1);
  let last = -1;
  let sawStrong = false;
  let close = -1;
  for (let j = start + 1; j < end; j++) {
    const cand = lines[j];
    if (RE_SEP.test(cand)) { close = j; break; }
    if (!cand.trim()) continue;
    const compact = cand.replace(/\s+/g, '');
    if (RE_SITE.test(compact) || RE_PIRATE.test(compact) || RE_URL.test(cand)) sawStrong = true;
    last = j;
  }
  if (!sawStrong) return -1;
  if (close !== -1) return close;      // 框到闭合分隔线为止（含）
  return last;                          // 没有闭合线：吃到最后一个非空行（≤5）
}

/**
 * 清洗一篇文本（逐行；广告框按结构锚整块删）。
 * @returns {{text:string, stats:object, samples:object}} stats=各类删除行数，samples=各类前 5 条样例（人工复核用）
 */
function cleanText(text) {
  const src = String(text == null ? '' : text).replace(RE_JUNK_CHAR, '');
  const lines = src.split('\n');
  const out = [];
  const stats = {};
  const samples = {};
  const bump = (cat, line) => {
    stats[cat] = (stats[cat] || 0) + 1;
    if (!samples[cat]) samples[cat] = [];
    if (samples[cat].length < 5) samples[cat].push(String(line).slice(0, 80));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE_SEP.test(line)) {
      const last = promoBlockEnd(lines, i);
      if (last > i) {
        for (let j = i; j <= last; j++) bump('ad_block', lines[j]);
        i = last + 1;
        continue;
      }
    }
    const verdict = classifyLine(line);
    if (verdict && verdict.action === 'drop') {
      bump(verdict.category, line);
      i++;
      continue;
    }
    out.push(verdict && verdict.action === 'replace' ? verdict.text : line);
    i++;
  }
  return { text: out.join('\n'), stats, samples };
}

module.exports = {
  cleanText, classifyLine, promoBlockEnd,
  RE_SITE, RE_PIRATE, RE_URL, RE_SEP, SITE_WORDS, PIRATE_WORDS,
};
