// 回复意图（reply-intent）：纯函数表驱动单测。
// 判定只依赖 { userText, resumed, facts, runState, hasPendingAction }，不看模型正文。
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyReplyIntent, isWriteTool } = require('../server/chat/reply-intent');
const { serializeHistory } = require('../server/chat/tool-history');

function cases(list) {
  for (const [name, input, expected] of list) {
    test(name, () => {
      assert.equal(classifyReplyIntent(input), expected);
    });
  }
}

// ---------------- 1. 操作类（resumed / 系统信封 / 待确认 / 写工具事实） ----------------
cases([
  ['resumed=true 一律 operation（不看用户原话）', { userText: '你好', resumed: true }, 'operation'],
  ['resumed=false 不误判', { userText: '你好', resumed: false }, 'unknown'],
  ['确认结果系统信封 → operation', { userText: '[确认执行结果·系统事件]\n此前你请求执行的写工具 replace_chapter（参数：{}）已执行成功。' }, 'operation'],
  ['信封前后空白仍可识别', { userText: '  [确认执行结果·系统事件]已执行成功' }, 'operation'],
  ['runState=awaiting_confirmation → operation', { userText: '你好', runState: { status: 'awaiting_confirmation' } }, 'operation'],
  ['hasPendingAction=true → operation', { userText: '你好', hasPendingAction: true }, 'operation'],
  ['runState=failed 不升级为 operation', { userText: '你好', runState: { status: 'failed' } }, 'unknown'],
]);

// ---------------- 2. 工具事实（注册表 mutation 判定） ----------------
cases([
  ['facts 含写工具 replace_chapter → operation', { userText: '你好', facts: [{ name: 'replace_chapter' }] }, 'operation'],
  ['facts 含归档工具 set_chapter_meta 若为写 → operation', { userText: '你好', facts: [{ name: 'append_chapter' }] }, 'operation'],
  ['facts 只含读工具 → 不判 operation，按原话继续', { userText: '续写', facts: [{ name: 'read_chapter' }] }, 'prose'],
  ['facts 未知名不抛错且不算写工具', { userText: '你好', facts: [{ name: 'tool_that_never_existed_xyz' }] }, 'unknown'],
  ['facts 空项/null 不抛错', { userText: '你好', facts: [null, undefined, {}] }, 'unknown'],
  ['facts 非数组不抛错', { userText: '你好', facts: 'nope' }, 'unknown'],
]);

// ---------------- 3. 祈使写作（prose 优先于讨论） ----------------
cases([
  ['续写 → prose', { userText: '续写' }, 'prose'],
  ['继续 → prose', { userText: '继续' }, 'prose'],
  ['接着。 → prose（标点收尾仍算）', { userText: '接着。' }, 'prose'],
  ['帮我写…可以吗？ → prose（祈使先于疑问）', { userText: '帮我写一段他们吵架的戏，可以吗？' }, 'prose'],
  ['再写一版 → prose', { userText: '再写一版' }, 'prose'],
  ['请直接重写第2段 → prose', { userText: '请直接重写第2段' }, 'prose'],
  ['给我润色一下 → prose', { userText: '给我润色一下' }, 'prose'],
  ['往下 → prose', { userText: '往下' }, 'prose'],
  ['改写成更冷峻的语气 → prose', { userText: '改写成更冷峻的语气' }, 'prose'],
  ['弱信号：写下去 → prose', { userText: '我看这段可以写下去' }, 'prose'],
  ['写一段 → prose', { userText: '写一段雨夜追逐' }, 'prose'],
  ['帮我写一场戏 → prose', { userText: '帮我写一场戏' }, 'prose'],
]);

// ---------------- 4. 讨论类（讨论先于弱写作信号） ----------------
cases([
  ['为什么…？ → discussion（不因含「续写」误判 prose）', { userText: '为什么你续写的这段这么平？' }, 'discussion'],
  ['这章节奏怎么样 → discussion', { userText: '这章节奏怎么样' }, 'discussion'],
  ['分析一下第三章 → discussion', { userText: '分析一下第三章' }, 'discussion'],
  ['给点建议 → discussion', { userText: '给点建议' }, 'discussion'],
  ['这段你怎么看？ → discussion', { userText: '这段你怎么看？' }, 'discussion'],
  ['写实主义怎么看 → discussion', { userText: '写实主义怎么看' }, 'discussion'],
  ['写作风格怎么样 → discussion', { userText: '写作风格怎么样' }, 'discussion'],
]);

// ---------------- 5. 其余归 unknown ----------------
cases([
  ['突出书架这个重点，其余细节降为背景 → unknown', { userText: '突出书架这个重点，其余细节降为背景' }, 'unknown'],
  ['空入参 → unknown', {}, 'unknown'],
  ['null 用户原话 → unknown', { userText: null }, 'unknown'],
]);

test('isWriteTool：读工具 false、写工具 true、未知名 false 不抛错', () => {
  assert.equal(isWriteTool('read_chapter'), false);
  assert.equal(isWriteTool('replace_chapter'), true);
  assert.equal(isWriteTool('no_such_tool_xyz'), false);
  assert.equal(isWriteTool(undefined), false);
});

test('serializeHistory 第4参 extra.intent 落到 run 条目，缺省为 null', () => {
  const withIntent = JSON.parse(serializeHistory([], { _toolFacts: [] }, {}, { intent: 'prose' })).find(e => e.kind === 'run');
  assert.equal(withIntent.intent, 'prose');
  const withoutIntent = JSON.parse(serializeHistory([], { _toolFacts: [] }, {})).find(e => e.kind === 'run');
  assert.equal(withoutIntent.intent, null);
  assert.equal(JSON.parse(serializeHistory([], { _toolFacts: [] }, {}, { intent: 'unknown' })).find(e => e.kind === 'run').intent, 'unknown');
});
