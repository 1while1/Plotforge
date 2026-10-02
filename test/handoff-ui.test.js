// S5-9（charter §2 豁免流程 ＋ §3 S5-9 行「本文件收尾退役」）：
// 原「规划笔记与显式交接」页面回归（7 例，vm 直读 public/legacy/agent.js 磁盘真源码，Agent 台勾选 →
// 存笔记 → 创建交接草案 → 预览 → 接受/作废全链）在本片的 Node 侧档案——**退役见证 3 条**。
//
// 动因＝结构性阻断：本片 `git rm public/legacy/agent.js`（同时删 index.html:769 标签行）后，原 harness
// 的 vm 装载链（chat-event-hub.js → agent.js → context.window.AgentPage）不再成立。
//
// 语义转写（Plan §2.4 表二逐条，全部落在 React 侧断言，非放宽）：
//   · :606 骨架与选择（勾选不发请求；工具条三入口）→ frontend/components/AgentSpace.test.jsx T5-6
//     ＋ E9（togglePick 去重＋按 Number(id) 升序）
//   · :635 存规划笔记（POST /api/planning-notes 体逐字、四字段回执、空正文拦截）→
//     frontend/hooks/use-agent-handoff.test.js T4-1~T4-4（S5-8 交付面）＋ E10（noteModalBodyHTML 段）
//   · :666/:733 交接两形态（书籍范围取本书写作会话；全局不自动挑书/会话、不夹带他书材料；预览后才
//     接受、一次点击一笔）→ T4-5/T4-6 ＋ E11（handoffComposeBodyHTML 三形态）
//   · :804/:848 作废与已采纳后作废（第三按钮、二次确认、空体 cancel、409「不撤回」不自动重试）→
//     T4-7/T4-8 ＋ E12
//   · :872 来源变更 409（重新预览、不拿旧指纹重试）→ T4-7（HANDOFF_SOURCE_CHANGED）＋ E11
// 计数约束＝Node 冻结面不得低于基线 1177（S5-4 整改 R1 立约）；本文件 7→3 的差额由
// test/agent-workspace-react.test.js（E1~E15 等价重钉）补足。
//
// 桩的纪律：本文件只做**反向断言**（旧件不在盘／旧标签零命中／静态壳与 React 供给件在位），
// 不复制实现细节；行为断言一律在 vitest 侧与 E 系列（双侧同源双钉，S5-7 同款收尾）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}

// Agent 页静态壳切片（index.html「AI 助手页」段；React 只填内层）
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

// S4-04b 必须提供的页面骨架（断言打在真实 index.html 上；S5-9 后语义＝静态壳原样保留）
const AGENT_SHELL_IDS = [
  'agent-messages', 'agent-text', 'agent-form',
  'agent-pick-bar', 'agent-pick-count', 'btn-agent-save-note', 'btn-agent-create-handoff', 'btn-agent-pick-clear',
];
// 原七例的写作页侧同页 id（不属 Agent 段，单独钉在 index.html 全文）
const CROSS_PAGE_IDS = ['chat-messages'];

// React 供给面：块二承接方（hook＋两组件＋挂载件＋三 lib）
const SUPPLY_FILES = [
  'frontend/components/AgentWorkspace.jsx',
  'frontend/components/AgentLiveRound.jsx',
  'frontend/components/AgentActionCard.jsx',
  'frontend/hooks/use-agent-workspace.js',
  'frontend/lib/agent-pending.js',
  'frontend/lib/agent-actions.js',
  'frontend/lib/agent-round.js',
];

// S5-8 交付的勾选/交接承接件（本文件原七例的 React 落点）
const HANDOFF_FILES = [
  'frontend/hooks/use-agent-handoff.js',
  'frontend/lib/agent-handoff.js',
  'frontend/components/AgentPickBar.jsx',
  'frontend/components/AgentMessageList.jsx',
];

// ---------- 退役见证（反向断言：职责移交 React 桥） ----------

test('S5-9 退役见证：agent.js 已 git rm 且 index.html 旧标签零命中', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'public/legacy/agent.js')),
    false,
    'public/legacy/agent.js 必须已 git rm（S5-9 块二收尾全退役）',
  );
  assert.equal(
    (indexHtml().match(/legacy\/agent\.js/g) || []).length,
    0,
    'index.html 不得再加载 agent.js（本片删 :769 标签行，无替代桩段）',
  );
});

test('S5-9 退役见证：Agent 页静态壳 id 全集仍在 index.html（勾选/交接四入口在位，壳未动）', () => {
  const html = indexHtml();
  const ids = shellIds();
  assert.equal(ids.length, 41, '静态壳 id 数不得变（含 #page-agent）：' + JSON.stringify(ids));
  for (const id of ids) {
    assert.equal(
      (html.match(new RegExp('id="' + id + '"', 'g')) || []).length,
      1,
      'index.html 内 id 必须恰一份：' + id,
    );
  }
  const missing = AGENT_SHELL_IDS.filter(id => ids.indexOf(id) < 0);
  assert.deepEqual(missing, [], '勾选/交接面静态壳缺失 id：' + missing.join(', '));
  for (const id of CROSS_PAGE_IDS) {
    assert.ok(html.indexOf('id="' + id + '"') > 0, '写作页侧静态壳必须仍在：' + id);
  }
});

test('S5-9 退役见证：React 供给件在位（挂载件＋两组件＋hook＋三 lib＋勾选/交接四件）', () => {
  for (const file of SUPPLY_FILES.concat(HANDOFF_FILES)) {
    assert.equal(
      fs.existsSync(path.join(root, file)),
      true,
      file + ' 必须存在（agent.js 块一/块二的 React 承接方）',
    );
  }
});
