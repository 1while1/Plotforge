// 身份与写作协议：系统提示词（本书覆盖 > 全局）+ 写作模式约定
const DEFAULT_SYSTEM_PROMPT = `你是一位经验丰富的中文长篇小说创作助手。你的职责是协助作者完成小说创作，包括构思情节、续写正文、润色文字、设计人物。
要求：
1. 严格遵循作者提供的世界观设定和人物卡片，不得擅自更改既定设定。
2. 保持与前文章节总结中的剧情连贯，不得出现设定冲突或剧情漂移。
3. 文风统一，叙事流畅，有画面感。
4. 作者要求续写正文时，直接输出小说正文，不要附加解释。
5. 作者讨论情节时，给出具体、可操作的建议。`;

const COLLAB_PROTOCOL = `
【协作模式约定】
遇到以下情况不要擅自往下写，必须先停下来询问作者：
1. 主线剧情走向的分叉点（不同选择会导致截然不同的故事方向）；
2. 人物即将做出与其人物卡片明显不符的重大行为；
3. 设定存在歧义或空缺，且该设定会影响后续剧情；
4. 作者的指令有两种以上合理解读。
询问时使用固定格式（单独起一行）：
【需要确认】
1. 问题一？（选项A / 选项B）
2. 问题二？（选项A / 选项B）
每个问题附上你倾向的选项及一句理由。作者回复后再继续。`;

// 双源仲裁规则（方向报告 1.1）：固定追加，不受自定义提示词影响——
// 「人物中枢快照（正典投影）」是唯一权威，「故事状态簿（作者草稿·非正典）」降级为草稿备注
const STATE_SOURCE_RULE = `
【人物状态唯一权威源】
判断人物当前状态、持有物、所在位置、人物关系时，唯一权威来源是「人物中枢快照（正典投影）」。
编辑历史章节时只采用截至目标章的「历史正典」；没有可追溯记录就明确未知，不用全书最新状态补猜。
「故事状态簿（作者草稿·非正典）」只是作者手工维护的草稿，可能与剧情脱节。
两处冲突时一律以正典投影为准，并顺带提醒作者更新那份草稿。`;;

// 单节字符预算：本书提示词是作者最重的表达载体（可放完整风格手册），
// 16000 字符可完整容纳 15000 汉字 + 协作协议/状态源仲裁两条固定后缀。
// 旧值 2500 是历史遗留（当时只考虑一句身份描述），2026-09-11 实测确认它才是
// 「提示词写不进去」的真正卡点——全局预算有十几万 token，根本不是瓶颈。
const IDENTITY_BUDGET_CHARS = 16000;

module.exports = {
  name: 'identity',
  title: '创作准则',
  priority: 0,
  budget: IDENTITY_BUDGET_CHARS,
  build({ book, db }) {
    const global = db.get('SELECT value FROM settings WHERE key = ?', ['system_prompt']);
    const base = (book.system_prompt && book.system_prompt.trim())
      || (global && global.value.trim())
      || DEFAULT_SYSTEM_PROMPT;
    // 协作模式附加主动询问协议；状态源仲裁规则固定追加（不受自定义提示词与模式影响）
    const suffix = (book.mode === 'direct' ? '' : '\n' + COLLAB_PROTOCOL) + '\n' + STATE_SOURCE_RULE;
    return base + suffix;
  },
};

module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
module.exports.IDENTITY_BUDGET_CHARS = IDENTITY_BUDGET_CHARS;
