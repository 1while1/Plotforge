// 风格层 Provider（作家仓库第二步）：把「这本书该怎么写」注入系统提示词。
//
// 解耦承诺（委托方「必须不能十分耦合」的落地）：
//   - 本 provider 只**读** style_packs / style_rules / books.style_pack_id，不写任何业务表；
//   - 写作流只通过本函数的返回值感知风格层——把它从 PROVIDERS 数组删掉，
//     或把全局开关关掉，写作行为立刻退回今天的状态，无残留副作用；
//   - 全部风格逻辑收在 server/style/ 与 server/detectors/ 两个目录里。
//
// 与时序无关：风格是数据，不是代码路径。规则内容怎么改都不用动这里。
const stylePacks = require('../../style/packs');

// 单节字符预算：**按字符（码点）计，不是 token**——与 identity 同一量纲，
// 便于直接和「规则条目总共多少字」对齐。
//
// 取 38000 的由来（2026-09-14 由 12000 上调；委托方要求容纳 **25000 汉字**，原要求是 10000）：
//   · 需求按**汉字**提，常量按**字符**计，两者之间要实测换算——旧注释里「汉字之外约占 15~20%
//     额外字符」是**估的、且偏低**：四张蒸馏卡实测 字符/汉字 = **1.344~1.460**（最密的是白石，
//     68.5% 汉字——规则行自带「每万汉字出现 1.11 次——1623 vs 24 次」这类数字与拉丁标记）。
//   · 按最密的那张折算：25000 × 1.460 = 36,500，留约 4% 余量 → **38000**。
//   · 换算量级：38000 字符 ≈ 26,600 本地估算 token（CJK 0.7 token/字）≈ 37,000 真实 token
//     （项目校准系数 1.387）。**这是上限不是常态**——实际占用 = 卡的真实大小，
//     实测四卡 10,234~16,344 字符，其中白石卡满注入 ≈ 9,100 token。
//   · 全局余量实测（书#19 绑白石卡）：整条系统提示 9,411 token / 窗口 200,000，free 174,589；
//     本改动约 +3,700 token，仍远在预算内（`/api/books/:id/context-breakdown` 可复查）。
// **2026-09-19 由 38000 上调至 48000（委托方指示「再提升提示词预算」）**：
//   范文材料同批扩容（retrieve.js SAMPLE_BUDGET 8000→16000、L4 k 8→16，四卡范文扩到
//   13,600~14,400 字符）：最密单卡（白石）满注入 ≈ 23,100 字符；主+辅同挂的最坏栈
//   ≈ 47,000 字符——38000 会触发按层降级，48000 留约 2% 余量。上限 ≈ 33,600 汉字量级，
//   窗口 200,000 仍安全；实际占用以卡的真实大小为准（`/api/style-lab/packs-preview` 可复查）。
// 真正超限时 compileCardsText 内部按层降级（范文 → 技法 → 硬线细则 → 只留人设与指纹），不会硬截出半个句子。
const STYLE_BUDGET_CHARS = 48000;

module.exports = {
  name: 'style',
  title: '文风约束',
  // priority 5：紧接 identity(0) 之后、世界观(10) 之前。
  // 理由：身份/协作协议是最上位约定，文风是紧随其后的「怎么写」约定，
  // 二者都应与具体设定（世界观/人物/大纲）分离，模型注意力分配也更清楚。
  priority: 5,
  budget: STYLE_BUDGET_CHARS,
  build({ book, db }) {
    // 全局开关：关掉后本 provider 完全不产出（写作流回到无风格层状态）
    if (!styleLayerEnabled(db)) return '';
    const bookId = book && Number.isFinite(book.id) ? book.id : null;
    // 主卡 + 辅卡一次编译成一段文本：分节注入会让模型把辅卡当成与主卡平级的另一套风格，
    // 合成一节才能表达「这是同一本书的写作约束，主卡说了算」。
    const resolved = stylePacks.resolveForBook(bookId);
    if (!resolved.chain.length) return '';
    return stylePacks.compileCardsText(resolved.chain.map(p => p.id), { maxChars: STYLE_BUDGET_CHARS });
  },
};

// 风格层总开关（settings.style_layer_enabled）：缺省开启。
// '0' / 'false' 视为关——与 settings 路由的布尔解析约定一致。
function styleLayerEnabled(db) {
  try {
    const row = db.get("SELECT value FROM settings WHERE key = 'style_layer_enabled'");
    if (!row || row.value === undefined || row.value === null) return true;
    const s = String(row.value).trim().toLowerCase();
    return !(s === '0' || s === 'false');
  } catch {
    return true; // settings 表不可用（独立脚本场景）时按默认开启
  }
}

module.exports.styleLayerEnabled = styleLayerEnabled;
module.exports.STYLE_BUDGET_CHARS = STYLE_BUDGET_CHARS;
