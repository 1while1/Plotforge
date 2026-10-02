// S5-7（charter §2 豁免流程 ＋ §3 S5-7 行「本文件收尾退役（git rm＋标签删）」）：
// 原「沉浸式写作与另开讨论」页面回归（10 例，vm 直读 public/legacy/*.js 磁盘真源码，其中
// book-chat.js 的 11 名 BookPage 契约是承接关键）在本片的 Node 侧档案——**退役见证 3 条**。
//
// 动因＝结构性阻断：本片 `git rm public/legacy/book-chat.js`（index.html:791 标签原位换成 11 名
// 委托桩段）后，原 harness 的 FILES 装载清单（book-chat.js）与 BookPage.show() 编排链不再成立
// （book.js:171-205 的 show 需要 bindChatEvents/loadWorld/loadCharacters/loadChat 四名）。
//
// 语义转写（Plan §2.4 表一逐条，全部落在 React 侧断言，非放宽）：
//   · 状态条常显/入口可达（:524/:773）→ frontend/components/ChatWorkspace.test.jsx T5-1（七入口与
//     首项）＋T5-13（左栏两入口幂等绑定）＋test/chat-workspace-react.test.js E1/E3（会话标签与选项映射）
//   · 折叠侧栏不打断流（:559）→ T5-8（零取消零重发）＋S5-6 冻结件 chat-transport.test.js（队列串行）
//   · 讨论只带选中文字/带人物/离开守卫（:601/:659/:680）→ T5-5（弹窗 bodyHTML、onOk 请求序、守卫）
//     ＋ E5~E9（handoffRefs/handoffIdAnchor/handoffTitle/pickCharacter/handoffMaterial/handoffScopeKey 逐字）
//   · 返回同会话同章（:712）→ T5-2（服务端 id 不一致时 rememberConversation 先行）＋ E1/E2（存储键与
//     query 逐字）＋ E4（remember/switch 调用序）
//   · 页面隐藏不宣告取消/完成（:741）→ T5-8（visibilitychange ⇒ setStatusPollingVisible、零请求）
//   · 409 CHAT_BUSY 排队重试（:792）→ S5-6 冻结件 frontend/lib/chat-transport.test.js T1-7/T1-8
//   · 同 SPA 进 Agent 台落点键（:813）→ T5-5/T5-11（agent_scope_v1/agent_conversation_v1＋saveWritingReturn
//     ＋location.hash）＋ E9（handoffScopeKey 两态）
// 计数约束＝Node 冻结面不得低于基线 1177（S5-4 整改 R1 立约）；本文件 10→3 的差额由
// test/chat-workspace-react.test.js（E1~E14 等价重钉）补足（1191−12＝1179 ≥ 1177）。
//
// 桩的纪律：本文件只做**反向断言**（旧件不在盘／旧标签零命中／React 供给件在位），不复制实现细节；
// 详细行为断言一律在 vitest 侧与 E 系列（双侧同源双钉）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}

// ---------- 退役见证（反向断言：职责移交 React 桥） ----------

test('S5-7 退役见证：book-chat.js 已从 public/legacy 移除（git rm，非死锚点）', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'public/legacy/book-chat.js')),
    false,
    'public/legacy/book-chat.js 必须已 git rm（S5-7 块三全退役）',
  );
});

test('P6-2 ⑨ 转写（原 S5-7 聊天桩段见证）：index.html 零内联段＋旧名零命中；11 名命令面由聊天模块面供给', () => {
  const html = indexHtml();
  assert.equal(
    (html.match(/legacy\/book-chat\.js/g) || []).length,
    0,
    'index.html 不得再加载 book-chat.js（标签原位换成委托桩段）',
  );
  // P6-2 ⑨（Plan §2.4 T-B2／T-A2 收窄合并）：index.html 三段内联承接桩（聊天桩段为其一）随切换笔清退 ⇒
  // 原「桩段形态／classic／段内 11 名／早于 segment-targets」诸断言对象消失，语义并入零内联段＋零旧名见证；
  // 11 名供给面改钉**聊天模块面**（原桩段的 1:1 承接方）。
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.equal(scripts.length, 1, '源 index.html 必须只剩一个 script（Vite entry 声明 /entry.jsx）');
  assert.ok(/\bsrc\s*=\s*["']\/entry\.jsx["']/.test(scripts[0]), '唯一 script 必须是 Vite entry 声明 /entry.jsx（产物 /app/entry.js 由 Vite 注入）');
  assert.ok(/type\s*=\s*["']module["']/.test(scripts[0]), '入口必须是 module（classic 内联段已清零）');
  const htmlCode = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const name of [
    'window.MozhenBookChat',
    'window.MozhenChapterEditor',
    'window.App',
    'window.BookPage',
  ]) {
    assert.equal(htmlCode.indexOf(name), -1, 'index.html 不得再出现 ' + name + '（P6-2 ⑨ 旧名清零，HTML 注释豁免）');
  }
  assert.equal(
    html.indexOf('legacy/segment-targets.js'),
    -1,
    'index.html 不得再加载 segment-targets.js（S5-10 起 React 静态 import）',
  );
  // 11 名命令面（原桩段逐名见证的模块等价物）
  const chat = fs.readFileSync(path.join(root, 'frontend/components/ChatWorkspace.jsx'), 'utf8');
  for (const name of [
    'openAgentDiscussion', 'setStatusPollingVisible', 'refreshRunStatus', 'renderRunCard',
    'loadChat', 'loadWorld', 'loadCharacters', 'bindChatEvents',
    'currentWritingConversationId', 'renderActionCard', 'renderToolEvent',
  ]) {
    assert.ok(chat.includes(name), '聊天模块面缺名：' + name);
  }
  assert.ok(
    /export function chatApi\(\)/.test(chat),
    '聊天命令面必须由 ChatWorkspace 的 chatApi() 模块面供给（原桩段 window.BookPage 同名的承接方）',
  );
});

test('P6-2 ⑨ 转写（原 S5-7 桥供给见证）：React 承接件在位（挂载件/hook/五 lib）＋桥零旧名（P6-2 退役）', () => {
  for (const file of [
    'frontend/components/ChatWorkspace.jsx',
    'frontend/hooks/use-chat-workspace.js',
    'frontend/lib/chat-session.js',
    'frontend/lib/chat-handoff.js',
    'frontend/lib/chat-context.js',
    'frontend/lib/chat-status.js',
    'frontend/lib/chat-side-lists.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file + ' 必须存在（book-chat.js 块三的 React 承接方）');
  }
  const bridge = fs.readFileSync(path.join(root, 'frontend/bridges/legacy-bridge.jsx'), 'utf8');
  // P6-2 ⑨（Plan §2.4 T-B1/T-E3）：守卫式旧名注册面随切换笔退役 ⇒ 断言反转为零命中；
  // 「11 名由 ChatWorkspace 命令面供给」的等价物＝模块面（上面第 3 条测试逐名见证）。
  const code = bridge.replace(/\/\/[^\n]*/g, '');
  assert.equal(code.indexOf('window.'), -1, '桥必须零 window 赋值/读取（P6-2 ⑨ 注册面退役）');
  assert.equal(/window\.BookPage\s*=/.test(code), false, '桥禁写 window.BookPage（旧桩段已随 P6-2 ⑨ 清退）');
  assert.equal(code.indexOf('window.MozhenBookChat'), -1, '旧名 window.MozhenBookChat 必须零命中');
  const chat = fs.readFileSync(path.join(root, 'frontend/components/ChatWorkspace.jsx'), 'utf8');
  assert.ok(
    /export function chatApi\(\)/.test(chat),
    '聊天 11 名命令面由 ChatWorkspace 的 chatApi() 模块面供给（原 window.MozhenBookChat 承接方的等价物）',
  );
  const panel = fs.readFileSync(path.join(root, 'frontend/components/ChapterEditorPanel.jsx'), 'utf8');
  assert.ok(
    /export function chapterEditorApi\(\)/.test(panel),
    '编辑器 8 名名义入口由 ChapterEditorPanel 的 chapterEditorApi() 模块面供给（原 window.MozhenChapterEditor）',
  );
});
