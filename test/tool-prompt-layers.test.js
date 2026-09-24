// M6 工具提示词三层化：snippet 短表常驻 + 截断续读指引
// 对齐 pi ToolDefinition 的 description/promptSnippet 分层（types.ts:451-500）与
// read 工具的 "Use offset=N to continue" 截断指引（read.ts:307-317）。
// 覆盖三点：① snippet 缺省退化行为；② 工具清单组装含 snippet；③ 截断指引文案存在。
const test = require('node:test');
const assert = require('node:assert/strict');
const { promptDescription, firstSentence, listTools, listAllTools, descriptor } = require('../server/tools/registry');
const { toOpenAITools } = require('../server/tools/adapters/openai');
const { descriptorSchemas } = require('../server/tools/adapters/ai-sdk');
const { truncateToolResult, capToolResult, truncationNotice, TOOL_RESULT_MAX_CHARS } = require('../server/tools/loop-helpers');

// ---------- ① snippet 缺省退化 ----------

test('promptDescription：有 snippet 优先，缺省退化为 description 首句', () => {
  // snippet 优先（前后空白被裁掉）
  assert.equal(promptDescription({ snippet: '  短描述  ', description: '完整说明。第二句。' }), '短描述');
  // 缺省退化：多句描述取首句（含句末标点）
  assert.equal(promptDescription({ description: '第一句。第二句。第三句。' }), '第一句。');
  // 单句描述退化后与原文一致（向后兼容：多数旧工具就是一句，零行为变化）
  assert.equal(promptDescription({ description: '阅读指定章节正文（默认最多3000字，长章用 read_chapter_range 分段）。' }),
    '阅读指定章节正文（默认最多3000字，长章用 read_chapter_range 分段）。');
  // 换行/叹号/问号同样是句子边界
  assert.equal(promptDescription({ description: '第一行\n第二行' }), '第一行');
  assert.equal(promptDescription({ description: '谁？是我。' }), '谁？');
  // 空值安全
  assert.equal(promptDescription({ description: '' }), '');
  assert.equal(promptDescription(null), '');
  assert.equal(promptDescription({}), '');
  // snippet 为非字符串时按缺省处理
  assert.equal(promptDescription({ snippet: 42, description: '一。二。' }), '一。');
});

test('firstSentence：码点无关的纯文本首句提取', () => {
  assert.equal(firstSentence('整段没有句号的长描述'), '整段没有句号的长描述');
  assert.equal(firstSentence(undefined), '');
});

// ---------- ② 工具清单组装含 snippet ----------

test('组装层（OpenAI/AI SDK adapter）序列化 snippet 短描述，registry 保留完整 description（三层分离）', async () => {
  const snippets = new Set(['list_chapters', 'batch_search', 'get_character_timeline', 'get_event_proposals', 'audit_character_states']);
  for (const profile of ['writing', 'agent', 'character']) {
    const openai = toOpenAITools(profile);
    for (const item of openai) {
      const name = item.function.name;
      assert.ok(item.function.description && item.function.description.trim(),
        `${profile}/${name} 组装后的 description 不应为空`);
      // 有 snippet 的工具：组装结果 === snippet，且明显短于完整描述
      if (snippets.has(name)) {
        const full = descriptor(name);
        assert.equal(item.function.description, full.snippet, `${profile}/${name} 应使用 snippet`);
        assert.ok(full.snippet.length <= 30, `${name} snippet 应 ≤30 字`);
        assert.ok(item.function.description.length < full.description.length,
          `${name} snippet 应短于完整 description`);
      }
    }
  }
  // 写作高频路径抽查：list_chapters（分页契约必须在短表存活）
  const writing = new Map(toOpenAITools('writing').map(t => [t.function.name, t.function.description]));
  assert.match(writing.get('list_chapters'), /offset/);
  assert.match(writing.get('list_chapters'), /truncated/);
  // 无 snippet 的单句工具：组装结果与完整 description 一致（退化 = 现行为）
  const rc = descriptor('read_chapter');
  assert.equal(writing.get('read_chapter'), rc.description);
  // 三层分离不变量：registry descriptor 的 description 字段仍为完整说明（确认卡/审计用）
  assert.ok(descriptor('audit_character_states').description.length > 200,
    '完整 description 不应被三层化改写');
  // AI SDK 路径（agent 助手页）同样接入
  const { loadSDK } = require('../server/agent/sdk');
  const { tool } = await loadSDK();
  assert.equal(typeof tool, 'function'); // SDK 可加载（描述改造不破坏 adapter 初始化）
  assert.ok(descriptorSchemas('agent').length > 0);
});

test('snippet 是纯元数据：注册表结构、profile 白名单与 JSON schema 不受影响', () => {
  // 全部注册工具仍可从 profile 到达（tool-registry 不变量的补充面：字段新增不产生死工具）
  const union = new Set();
  for (const profile of ['writing', 'agent', 'character']) {
    listTools(profile).forEach(t => union.add(t.name));
  }
  const dead = listAllTools().map(t => t.name).filter(name => !union.has(name));
  assert.deepEqual(dead, []);
  // 带 snippet 的工具 inputSchema 仍是 object（schema 未被三层化触碰）
  for (const name of ['list_chapters', 'get_character_timeline', 'get_event_proposals', 'audit_character_states', 'batch_search']) {
    const d = descriptor(name);
    assert.equal(d.inputSchema.type, 'object', `${name} schema 类型不变`);
    assert.equal(typeof d.snippet, 'string', `${name} 应有 snippet`);
  }
});

// ---------- ③ 截断续读指引 ----------

test('truncateToolResult：截断后缀带可行动续读指引且单条上限仍严格成立', () => {
  const long = 'x'.repeat(5000);
  const clipped = truncateToolResult(long, 1000);
  // 剩余量标注保留（既有行为）
  assert.ok(clipped.includes('已截断'));
  assert.ok(clipped.includes('剩余约4000字符'), '截断后缀应标注剩余量');
  // 可行动指引（对齐 pi "Use offset=N to continue"）：指明分页/分段/收紧三条续读通道
  assert.ok(clipped.includes('offset=next_cursor'), '应指引分页信封 offset=next_cursor 续读');
  assert.ok(clipped.includes('read_chapter_range'), '应指引长正文用 read_chapter_range 分段');
  assert.ok(clipped.includes('limit/topK'), '应指引列表/检索收紧 limit/topK 重取');
  assert.ok(clipped.includes('勿基于不完整结果'), '应警示勿基于残缺结果下断言');
  // reserveSuffix：内容+指引合计不超 maxChars（上限维持现状）
  assert.ok(Array.from(clipped).length <= 1000, '截断结果总长不应超过 maxChars');
  // 默认上限仍为 3000
  const big = truncateToolResult('y'.repeat(9999));
  assert.ok(Array.from(big).length <= TOOL_RESULT_MAX_CHARS);
});

test('capToolResult：超限 JSON 降级字符串带续读指引；未超限与确认信封原样返回', () => {
  // 超限对象 → 截断字符串 + 指引
  const huge = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, text: 'z'.repeat(30) })) };
  const capped = capToolResult(huge, 2000);
  assert.equal(typeof capped, 'string');
  assert.ok(capped.includes('offset=next_cursor'));
  assert.ok(capped.includes('read_chapter_range'));
  assert.ok(capped.includes('剩余约'));
  // 未超限：对象原样返回（语义不变）
  const small = { ok: true, total: 3 };
  assert.equal(capToolResult(small), small);
  // 确认信封：永不截断、保持对象结构
  const envelope = { status: 'confirmation_required', confirmation: { id: 'c1' } };
  assert.equal(capToolResult(envelope), envelope);
});

test('truncationNotice：导出的指引文案覆盖三类续读通道（≥3 例独立断言）', () => {
  const notice = truncationNotice(1234);
  assert.ok(notice.includes('剩余约1234字符'), '剩余量数字化');
  assert.ok(/offset=next_cursor/.test(notice), '分页通道');
  assert.ok(/read_chapter_range\(start,length\)/.test(notice), '分段通道');
  assert.ok(/limit\/topK/.test(notice), '收紧通道');
});
