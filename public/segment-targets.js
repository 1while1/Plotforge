// 段级靶点诊断（去 AI 率归因 2026-09-14）：把「哪几段该改」这件事从分数里剥离出来。
//
// 为什么要有它：实测（docs/report/20260914_去AI率归因）表明——
//   1) 整篇检测分是篇章级聚合，章内 ~700 字窗口只有 0.68~0.89，分数不能定位病灶；
//   2) 把分数贴给模型让它改，实测 0.9999→0.9999，且模型把段落拆得更碎；
//   3) 有效路径是人按「具体段落」改写。
// 所以这里只做**确定性**的文本特征诊断（每个标签都能在原文里数出来），给出「第几段、
// 有什么可指名的毛病」——**绝不输出任何检测分数**，也绝不声称这些标签能降分
// （消融实验证明删掉这些特征整篇读数不动）。它们是给人和给模型的「改写靶点」，不是达标线。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SegmentTargets = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 每个探针：key 稳定标识、label 人话、hint 改写方向、re 计数用、min 达到多少算命中。
  var PROBES = [
    { key: 'simile', label: '比喻密集', hint: '把比喻换成具体动作或物件', re: /像|似的|仿佛|宛如|如同|好似/g, min: 2 },
    { key: 'onomatopoeia', label: '拟声词', hint: '拟声词留给真正需要的一声，别当标点用', re: /咚|砰|轰|哗|咔|唰|嗖|嗡|叮|当啷|嗡嗡/g, min: 2 },
    { key: 'bodyTic', label: '身体反应模板', hint: '同样的紧张别再写瞳孔/嘴角/喉结', re: /青筋|瞳孔|嘴角|脸色|后背|牙根|喉结|鼻尖|指尖|心口|头皮|汗毛|眼皮|呼吸一|一顿|一僵|一沉|一颤/g, min: 2 },
    { key: 'cliche', label: '套话虚词', hint: '「瞬间/缓缓/微微」这类副词按需删', re: /瞬间|顿时|不禁|不由|缓缓|微微|淡淡|轻轻|静静|默默|竟然|居然|显然|猛地|蓦地|倏地/g, min: 3 },
    { key: 'emotionLabel', label: '情绪直呼', hint: '别命名情绪，写他做了什么', re: /愤怒|悲伤|喜悦|恐惧|惊讶|兴奋|绝望|痛苦|无奈|尴尬|羞愧|温柔|冷漠/g, min: 2 },
    { key: 'exclaim', label: '感叹号密集', hint: '把语气交给句子结构而不是感叹号', re: /！/g, min: 2 },
    { key: 'listy', label: '排比/并列堆叠', hint: '同构短句连排容易读成机器节奏，拆开或换个说法', re: /[^，。！？；]{1,8}、[^，。！？；]{1,8}、[^，。！？；]{1,8}/g, min: 1 },
    { key: 'elevate', label: '结尾在总结/升华', hint: '砍掉段末的总结句，让段落停在具体的事上', re: /(终将|注定|从此|这一刻|而这|未来的|注定要|他知道|她知道|只是他|也许这)[^。！？]{0,24}[。！？]?$/g, min: 1, tail: 28 },
  ];

  // 句长过于均匀：>=3 句且变异系数 < 0.35（人写通常长短交错）
  var SENT_SPLIT = /(?<=[。！？…”」])/;

  function count(text, re) {
    var m = String(text || '').match(re);
    return m ? m.length : 0;
  }

  function sentenceStats(text) {
    var sents = String(text || '').split(SENT_SPLIT).map(function (s) { return s.replace(/\s+/g, ''); })
      .filter(function (s) { return s.length > 0; });
    if (sents.length < 3) return null;
    var lens = sents.map(function (s) { return Array.from(s).length; });
    var mean = lens.reduce(function (a, b) { return a + b; }, 0) / lens.length;
    if (!mean) return null;
    var sd = Math.sqrt(lens.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / lens.length);
    return { count: sents.length, mean: Math.round(mean * 10) / 10, cv: Math.round((sd / mean) * 100) / 100 };
  }

  function tail(text, n) {
    var s = String(text || '');
    return Array.from(s).slice(-n).join('');
  }

  /**
   * 诊断一段文本，返回命中的靶点（按确定性计数，不含任何检测分数）。
   * @param {string} text
   * @returns {Array<{key:string,label:string,hint:string,count:number,detail?:string}>}
   */
  function diagnose(text) {
    var s = String(text || '');
    if (!s.trim()) return [];
    var hits = [];
    for (var i = 0; i < PROBES.length; i++) {
      var p = PROBES[i];
      var target = p.tail ? tail(s, p.tail) : s;
      var n = count(target, p.re);
      if (n >= p.min) hits.push({ key: p.key, label: p.label, hint: p.hint, count: n });
    }
    var st = sentenceStats(s);
    if (st && st.cv < 0.35) {
      hits.push({ key: 'evenSentences', label: '句长整齐', hint: '长短句拉开差距，别每句都一样长',
        count: st.count, detail: st.count + ' 句 · 均 ' + st.mean + ' 字 · 波动 ' + st.cv });
    }
    var chars = Array.from(s.replace(/\s+/g, '')).length;
    var sents = s.split(SENT_SPLIT).filter(function (x) { return x.trim(); }).length;
    // 必须有句末标点才算「句子」：章节标题行（「第二章」3 字）也会单行成段，
    // 那不是 tic，把它贴成靶点只会制造噪声。
    if (sents === 1 && chars <= 30 && /[。！？…]/.test(s)) {
      hits.push({ key: 'oneLineParas', label: '单句成段', hint: '短段可以留，但别整章都是', count: 1 });
    }
    return hits;
  }

  /** 段落切分：按空行/换行切，去掉空白段，保留原序。 */
  function splitParagraphs(text) {
    return String(text || '').split(/\r?\n+/).map(function (t) { return t.trim(); })
      .filter(function (t) { return t.length > 0; })
      .map(function (t, i) { return { index: i, text: t }; });
  }

  /**
   * 生成给人/给模型的「改稿目标清单」——只有段落与可指名的毛病，**没有分数**。
   * @param {Array<{index:number,text:string,label?:number,conf?:number}>} segments
   * @param {{withText?:boolean, onlyAi?:boolean}} [opts] onlyAi=true 时只收 label===1（朱雀判 AI）的段
   */
  function buildBrief(segments, opts) {
    var o = opts || {};
    var withText = o.withText !== false;
    var rows = (segments || []).filter(function (s) {
      if (!s || !String(s.text || '').trim()) return false;
      if (o.onlyAi && s.label !== 1) return false;
      return true;
    });
    if (!rows.length) return '（没有可定位的段落）';
    var head = o.onlyAi
      ? '以下 ' + rows.length + ' 段请逐段重写（只改这些段，别动其余部分）：'
      : '以下 ' + rows.length + ' 段请逐段重写：';
    var body = rows.map(function (s) {
      var tags = diagnose(s.text);
      var why = tags.length ? '　← ' + tags.map(function (t) { return t.label; }).join('、') : '';
      return (withText ? String(s.text) + why : '第 ' + (s.index + 1) + ' 段：' + tags.map(function (t) { return t.label; }).join('、')) + '\n';
    }).join('\n');
    return head + '\n\n' + body;
  }

  /** 只列要改的段落正文（供人改，绝不含分数与标签）。 */
  function buildTextList(segments, opts) {
    var rows = (segments || []).filter(function (s) { return s && String(s.text || '').trim(); });
    if (opts && opts.onlyAi) rows = rows.filter(function (s) { return s.label === 1; });
    return rows.map(function (s) { return String(s.text).trim(); }).join('\n\n');
  }

  return {
    PROBES: PROBES,
    diagnose: diagnose,
    sentenceStats: sentenceStats,
    splitParagraphs: splitParagraphs,
    buildBrief: buildBrief,
    buildTextList: buildTextList,
  };
});
