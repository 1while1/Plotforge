// S5-9（charter §2 豁免流程 ＋ §3 S5-9 行「本文件收尾退役（git rm＋标签删）」）：
// 原「Agent 台书籍交流 + 受控资源视图」页面回归（6 例，vm 直读 frontend/index.html 真实 id 集合与
// public/legacy/agent.js 磁盘真源码）在本片的 Node 侧档案——**退役见证 3 条**。
//
// 动因＝结构性阻断：本片 `git rm public/legacy/agent.js`（同时删 index.html:769 标签行）后，原 harness
// 的 vm 装载链（chat-event-hub.js → agent.js → context.window.AgentPage.show()）不再成立。
//
// 语义转写（Plan §2.4 表一逐条，全部落在 React 侧断言，非放宽）：
//   · :384 骨架（范围/会话/边界/状态行/mode 禁用、missingIds 空）→ frontend/components/AgentWorkspace
//     .test.jsx T5-1/T5-2 ＋ frontend/components/AgentSpace.test.jsx T5-1/T5-2 ＋ E1
//   · :409 流程一（切书→选中该书会话→发送体 conversation_id/content、无 mode/book_id/chapterId）→
//     AgentWorkspace.test.jsx T5-8 ＋ E5（buildSendPayload 四态）
//   · :447 流程二（chapterId 传递；切回全局清边界、全局请求不带 chapterId）→ AgentWorkspace.test.jsx
//     T5-5（边界非冒泡 change 承接）＋ E2（resolveBoundaryChapterId）／E5
//   · :484 流程三（资源 URL 形状、索引 2/3 行、预览 link href、收起）→ S5-8 AgentSidePanel 交付面
//     ＋ E3（resourceListUrl／cursor／hint）／E4（resourceDetailUrl）
//   · :536 范围纪律（复用现有会话；浏览不建会话；发送按范围建 {kind,scope,bookId}；无 PUT/PATCH）→
//     AgentWorkspace.test.jsx T5-2/T5-5 ＋ E1（scope 恢复）／E7（buildNewConversationBody）
//   · :580 权限纪律（global 禁用；mode:'execute'＋book_id；回落；全局资源不带 bookId）→ E5 ＋ E3
// 计数约束＝Node 冻结面不得低于基线 1177（S5-4 整改 R1 立约）；本文件 6→3 的差额由
// test/agent-workspace-react.test.js（E1~E15 等价重钉）补足。
//
// 桩的纪律：本文件只做**反向断言**（旧件不在盘／旧标签零命中／React 供给件在位），不复制实现细节；
// 详细行为断言一律在 vitest 侧与 E 系列（双侧同源双钉，S5-7 同款收尾）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}

// Agent 页静态壳切片（index.html「AI 助手页」段；id 全集的权威锚——React 只填内层，
// 容器 #page-agent 的类名归 AppRouter，故静态壳逐字保留）
function agentShell() {
  const html = indexHtml();
  const from = html.indexOf('<!-- ============ AI 助手页 ============ -->');
  const to = html.indexOf('<!-- ============ 阅读 / 精修工作台 ============ -->');
  assert.ok(from > 0 && to > from,
    'index.html 必须保留「AI 助手页」段与其后「阅读 / 精修工作台」段两个注释锚');
  return html.slice(from, to);
}

function shellIds() {
  const ids = [];
  const re = /id="([^"]+)"/g;
  const shell = agentShell();
  let m = re.exec(shell);
  while (m) { ids.push(m[1]); m = re.exec(shell); }
  return ids;
}

// 页面骨架必须提供的 id（断言打在真实 index.html 上，而不是桩上；S5-9 后语义＝静态壳原样保留）
const REQUIRED_IDS = [
  'agent-main', 'agent-scope-select', 'agent-scope-status', 'agent-conversation-select', 'agent-boundary-select',
  'btn-agent-mode', 'agent-conversation-list', 'agent-tool-list',
  'agent-pane-conversations', 'agent-pane-resources', 'btn-agent-tab-conversations', 'btn-agent-tab-resources',
  'agent-res-type', 'agent-res-list', 'btn-agent-res-more', 'agent-res-hint',
  'agent-preview-panel', 'agent-preview-body', 'btn-agent-preview-close',
  'agent-messages', 'agent-form', 'agent-text', 'btn-agent-send', 'btn-agent-stop',
  'btn-agent-clear', 'btn-agent-compress', 'btn-agent-restore', 'agent-legacy-import',
];

// React 供给面（agent.js 块二的承接方）：挂载件＋两组件＋hook＋三 lib
const SUPPLY_FILES = [
  'frontend/components/AgentWorkspace.jsx',
  'frontend/components/AgentLiveRound.jsx',
  'frontend/components/AgentActionCard.jsx',
  'frontend/hooks/use-agent-workspace.js',
  'frontend/lib/agent-pending.js',
  'frontend/lib/agent-actions.js',
  'frontend/lib/agent-round.js',
];

// ---------- 退役见证（反向断言：职责移交 React 桥） ----------

test('S5-9 退役见证：public/legacy/agent.js 已从 public/legacy 移除（git rm，非死锚点）', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'public/legacy/agent.js')),
    false,
    'public/legacy/agent.js 必须已 git rm（S5-9 块二收尾全退役）',
  );
  // 相邻 legacy 件不得被本片牵连（chat-event-hub.js 是 S5-9 的只读依赖物，且是 S4-10 冻结死锚点）；
  // S5-10 转写（Plan §5.3）：run-status.js／segment-targets.js 已 lib 化并 git rm 全退役 ⇒ 见证方向反转。
  assert.equal(
    fs.existsSync(path.join(root, 'public/legacy', 'chat-event-hub.js')),
    true,
    '相邻 legacy 件必须仍在：public/legacy/chat-event-hub.js',
  );
  for (const name of ['run-status.js', 'segment-targets.js']) {
    assert.equal(
      fs.existsSync(path.join(root, 'public/legacy', name)),
      false,
      'S5-10 起必须已 git rm（lib 化＋旧名桥/静态 import）：public/legacy/' + name,
    );
  }
});

test('S5-9 退役见证：index.html 旧标签零命中＋Agent 页静态壳 id 全集仍在（41 id 各恰一份）', () => {
  const html = indexHtml();
  assert.equal(
    (html.match(/legacy\/agent\.js/g) || []).length,
    0,
    'index.html 不得再加载 agent.js（本片删 :769 标签行，无替代桩段）',
  );
  assert.ok(html.indexOf('entry.jsx') > 0, 'index.html 必须保留 React 入口声明（Vite entry /entry.jsx；产物 /app/entry.js 归构建门禁）');
  assert.equal(html.replace(/<!--[\s\S]*?-->/g, '').indexOf('/app/entry.js'), -1, '源 index.html 不得再有指向产物路径的手工标签（P6-3 D1 判据；注释面历史说明豁免）');
  const ids = shellIds();
  assert.equal(ids.length, 41, '静态壳 id 数不得变（含 #page-agent）：' + JSON.stringify(ids));
  for (const id of ids) {
    assert.equal(
      (html.match(new RegExp('id="' + id + '"', 'g')) || []).length,
      1,
      'index.html 内 id 必须恰一份：' + id,
    );
  }
  const missing = REQUIRED_IDS.filter(id => ids.indexOf(id) < 0);
  assert.deepEqual(missing, [], 'Agent 页静态壳缺失 id（桩比页面宽的反面）：' + missing.join(', '));
});

test('P6-2 ⑨ 转写（原 S5-9 桥供给见证）：React 供给件在位＋桥零旧名（window.AgentPage 退役）', () => {
  for (const file of SUPPLY_FILES) {
    assert.equal(
      fs.existsSync(path.join(root, file)),
      true,
      file + ' 必须存在（agent.js 块二的 React 承接方）',
    );
  }
  const bridge = fs.readFileSync(path.join(root, 'frontend/bridges/legacy-bridge.jsx'), 'utf8');
  // P6-2 ⑨（Plan §2.4 T-E3）：桥的守卫式旧名注册面随切换笔退役 ⇒ 断言反转为**零命中**；
  // 「show 由挂载件供给」的等价物＝AgentWorkspace 模块导出＋AppRouter 静态 import 直取。
  const bridgeCode = bridge.replace(/\/\/[^\n]*/g, '');
  assert.equal(
    (bridgeCode.match(/window\.AgentPage\b/g) || []).length,
    0,
    '桥必须零 window.AgentPage（P6-2 ⑨ 注册面退役；名字承接改模块面）',
  );
  assert.equal(bridgeCode.indexOf('window.'), -1, '桥必须零 window 赋值/读取（P6-2 ⑨ 全退）');
  const agent = fs.readFileSync(path.join(root, 'frontend/components/AgentWorkspace.jsx'), 'utf8');
  assert.ok(
    /export async function showAgentWorkspace\(\)/.test(agent),
    'showAgentWorkspace 必须由 AgentWorkspace 挂载件供给（原 window.AgentPage.show 的等价物）',
  );
  const router = fs.readFileSync(path.join(root, 'frontend/AppRouter.jsx'), 'utf8');
  assert.ok(
    /import \{ showAgentWorkspace \} from "\.\/components\/AgentWorkspace\.jsx";/.test(router),
    'AppRouter 必须静态 import showAgentWorkspace（原 window.AgentPage.show 消费方）',
  );
  // 不写旧件名：React 供给面的**代码行**零命中（注释内的行号文献锚点是工程惯例，S5-7 同款）
  const codeHits = [];
  for (const file of SUPPLY_FILES.concat(['frontend/bridges/legacy-bridge.jsx'])) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.indexOf('legacy/agent.js') < 0) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      codeHits.push(file + ':' + (i + 1));
    });
  }
  assert.deepEqual(codeHits, [], 'React 供给面代码行不得引用已退役的旧件名：' + codeHits.join(', '));
});
