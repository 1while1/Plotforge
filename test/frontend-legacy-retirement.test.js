// S5-10（Plan §4 R5；charter §3 S5-10 行「死锚点退役清点」）：public/legacy 收官清点的反向见证。
//
// 判据（Plan §2.3）＝「活代码/测试读取者为零」＋「消费方全 React」；每件退役在此留反向见证：
//   ①本片 git rm 的 13 件不在盘；②有案保留的 4 件在位且其测试读取者锚点可验证；③index.html
//   对 legacy/*.js 零引用；④React 供给件在位。
//
// 保留 4 件的结构性理由（不静默，逐件锚点可验证；Plan §0.4 表）：
//   · book-chapters.js（938）——test/helpers/editor-vm.js:48 vm 装载链（重写 editor-vm＝重构测试仪器，
//     非机械转写；S5-2 判定项）。
//   · chapter-collapse.js（126）——test/chapter-collapse.test.js:8 require 直读＋editor-vm.js:46
//     （D-S3-1-01；其「阶段五处置」措辞同步归 Architect 收口，非本片实施面）。
//   · chapter-conflict.js（75）——editor-vm.js:47。
//   · chat-event-hub.js（403）——test/run-frontend.test.js:11＋test/chat-run-policy.test.js:218
//     （S4-10 判定 A·B 死锚点设计：vm 冻结直读）。
//
// P6-2 ⑨ 转写留案（charter §2 豁免流程：仅语义等价／机械转写／逐条留案；本件 4 用例计数不变）：
//   第 4 例的两条旧断言（`:97` 桥把 lib 单例接到 window.RunStatus、`:101` use-chat-workspace.js
//   仍经旧名 window.RunStatus）所指的旧名注册面与旧名消费面，正是 P6-2 ⑨ 的退役对象 ⇒ 按同型
//   「零命中＋模块承接件在位」转写（runStatus 由消费方 `import { runStatus } from "../lib/run-status.js"`
//   直取）；第 1~3 例（死锚点清点／保留锚点／index.html 零引用）与第 4 例后半（segment-targets 静态
//   import 两面）逐字未改。判定依据＝charter §2「冻结测试转写豁免流程」＋编排层整改指令（全量门禁
//   曾因此件 1 例红而 fail=1）。台账见 `11-阶段六-执行台账.md` §P6-2-整改（P6-2-X1）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const LEGACY = path.join(root, 'public/legacy');

// 本片 git rm 的 13 件（Plan §0.4；含 S5-10 两迁移件）
const RETIRED = [
  'app.js',
  'book.js',
  'book-outline.js',
  'book-state.js',
  'character-relations.js',
  'character-workbench.js',
  'focus-mode.js',
  'ledger-workbench.js',
  'outline-workbench.js',
  'rewrite-curve.js',
  'run-status.js',
  'segment-targets.js',
  'style-health.js',
];

// 有案保留的 4 件（理由见文件头注，锚点由第二例验证）
const KEPT = ['book-chapters.js', 'chapter-collapse.js', 'chapter-conflict.js', 'chat-event-hub.js'];

const REACT_SUPPLY = [
  'frontend/lib/run-status.js',
  'frontend/lib/segment-targets.js',
  'frontend/lib/rewrite-curve.js',
  'frontend/lib/character-relations.js',
  'frontend/lib/chat-event-hub.js',
  'frontend/lib/workspace-state.js',
  'frontend/bridges/legacy-bridge.jsx',
  'frontend/pages/BookShell.jsx',
  'frontend/components/ChapterEditorPanel.jsx',
];

function indexHtml() {
  return fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
}

test('S5-10 退役清点：13 件 legacy 死锚点不在盘（git rm 全退役）', () => {
  for (const name of RETIRED) {
    assert.equal(
      fs.existsSync(path.join(LEGACY, name)),
      false,
      'public/legacy/' + name + ' 必须已 git rm（消费方全 React，活读取者为零）',
    );
  }
  const left = fs.readdirSync(LEGACY).filter((n) => n.endsWith('.js')).sort();
  assert.deepEqual(left, [...KEPT].sort(), 'public/legacy 收官形态＝仅 4 件有案保留件：' + JSON.stringify(left));
});

test('S5-10 保留清点：4 件在位且测试读取者锚点仍在（保留理由可验证，不静默）', () => {
  for (const name of KEPT) {
    assert.equal(fs.existsSync(path.join(LEGACY, name)), true, 'public/legacy/' + name + ' 必须仍在（有案保留）');
  }
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const editorVm = read('test/helpers/editor-vm.js');
  assert.ok(editorVm.includes("public/legacy/chapter-collapse.js"), 'editor-vm.js 必须仍 vm 装载 chapter-collapse.js');
  assert.ok(editorVm.includes("public/legacy/chapter-conflict.js"), 'editor-vm.js 必须仍 vm 装载 chapter-conflict.js');
  assert.ok(editorVm.includes("public/legacy/book-chapters.js"), 'editor-vm.js 必须仍 vm 装载 book-chapters.js');
  assert.ok(read('test/chapter-collapse.test.js').includes("public/legacy/chapter-collapse"), 'chapter-collapse.test.js:8 必须仍 require 直读');
  assert.ok(read('test/run-frontend.test.js').includes("public/legacy/chat-event-hub.js"), 'run-frontend.test.js:11 vm 冻结直读必须在位');
  assert.ok(read('test/chat-run-policy.test.js').includes("public/legacy/chat-event-hub.js"), 'chat-run-policy.test.js:218 vm 冻结直读必须在位');
});

test('S5-10 零引用：index.html 对 legacy/*.js 零命中（收官形态），React 入口仍在', () => {
  const html = indexHtml();
  const hits = html.match(/legacy\/[A-Za-z0-9._-]+\.js/g) || [];
  assert.deepEqual(hits, [], 'index.html 不得再引用任何 legacy/*.js：' + JSON.stringify(hits));
  assert.ok(html.indexOf('entry.jsx') > 0, 'index.html 必须保留 React 入口声明（Vite entry /entry.jsx；产物 /app/entry.js 归构建门禁）');
  assert.equal(html.replace(/<!--[\s\S]*?-->/g, '').indexOf('/app/entry.js'), -1, '源 index.html 不得再有指向产物路径的手工标签（P6-3 D1 判据；注释面历史说明豁免）');
});

test('S5-10 React 供给件在位（P6-2 ⑨ 转写）：两迁移 lib＋消费方改模块直取＋桥零旧名注册面', () => {
  for (const file of REACT_SUPPLY) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file + ' 必须存在（S5-10 承接方）');
  }
  const bridge = fs.readFileSync(path.join(root, 'frontend/bridges/legacy-bridge.jsx'), 'utf8');
  // P6-2 ⑨ 转写（charter §2 豁免流程；语义等价·机械转写·逐条留案）：
  //   旧「桥必须把 lib 单例接到 window.RunStatus」（本文件原 :97）→ 新「旧名注册面退役，桥零 window.RunStatus；
  //   runStatus 由消费方经 lib 模块面直取」（P6-2 ⑨ 同笔落地的等价承接件，见证点＝下面的 hook 断言）。
  //   旧「use-chat-workspace.js:96 仍经旧名 window.RunStatus（产品面零改）」（原 :101）→ 新「同文件改
  //   `import { runStatus } from "../lib/run-status.js"` 直取且 window.RunStatus 零命中」（等值：同一单例、
  //   同一调用点次序，仅供给面由旧名桥换成模块导出；真单例语义由 frontend/lib/runtime-singletons.test.js 见证）。
  //   旧「桥必须守卫式注册 window.X」的整类断言随 P6-2 退役面消失，语义并入 zero-global T1 零残留静态见证。
  assert.equal(
    (bridge.match(/window\.RunStatus\b/g) || []).length,
    0,
    '旧名桥的 window.RunStatus 注册面必须退役（P6-2 ⑨；等价承接件＝lib 单例直取）',
  );
  assert.ok(
    bridge.includes('export function initFrontendRuntime()'),
    '桥必须保留为运行时初始化入口（P6-2 ⑨ 后零 window 赋值）',
  );
  assert.equal((bridge.match(/window\.SegmentTargets/g) || []).length, 0, 'segment-targets 已静态 import，桥不承接该旧名');
  // 两迁移件的消费面：run-status 由消费方直取 lib 单例（判断 C 的收益点），segment-targets 改静态 import
  const hook = fs.readFileSync(path.join(root, 'frontend/hooks/use-chat-workspace.js'), 'utf8');
  assert.ok(
    hook.includes('import { runStatus } from "../lib/run-status.js";'),
    'use-chat-workspace.js 必须经 lib 单例直取 runStatus（P6-2 ⑨ 前为 :96 经旧名 window.RunStatus）',
  );
  assert.equal(
    (hook.match(/window\.RunStatus\b/g) || []).length,
    0,
    'use-chat-workspace.js 的旧名 window.RunStatus 必须零命中（P6-2 ⑨ 退役）',
  );
  const shp = fs.readFileSync(path.join(root, 'frontend/components/StyleHealthPanel.jsx'), 'utf8');
  assert.ok(shp.includes('from "../lib/segment-targets.js"'), 'StyleHealthPanel 必须静态 import segment-targets');
  assert.equal((shp.match(/window\.SegmentTargets/g) || []).length, 0, 'StyleHealthPanel 不得再读 window.SegmentTargets');
  const rcp = fs.readFileSync(path.join(root, 'frontend/components/RewriteCurvePanel.jsx'), 'utf8');
  assert.ok(rcp.includes('from "../lib/segment-targets.js"'), 'RewriteCurvePanel 必须静态 import segment-targets');
  // 只计**成员访问**（window.SegmentTargets.xxx）：头注里的历史形态行（「:11 的解析期
  // `var ST = window.SegmentTargets` 捕获随 legacy 文件退役自然消亡」）是事实说明，非活读取。
  assert.equal((rcp.match(/window\.SegmentTargets\./g) || []).length, 0, 'RewriteCurvePanel 不得再读 window.SegmentTargets');
});

test('P6-5 终局定格：4 件死锚点行数恰 938/126/75/403＝1,542（裁定 #2 常驻声明见证）', () => {
  // 见证笔（追加即绿，无红态）：charter §0 裁定 #2「死锚点有案保留」的机械形态——逐件行数钉死，
  // 死锚点被意外改动（哪怕 1 行）即红，改动须留案。行数按读文件数 `\n` 计（＝wc -l 口径）。
  // 注：charter §0 裁定 #2 原文第三件写「book-conflict.js 75」为笔误，实际文件名＝chapter-conflict.js
  //（ls public/legacy/ 实证；AGENTS.md 保留清单用名正确）；快照与声明以实际文件名为准。
  const EXPECT_LINES = {
    'book-chapters.js': 938,
    'chapter-collapse.js': 126,
    'chapter-conflict.js': 75,
    'chat-event-hub.js': 403,
  };
  let total = 0;
  for (const name of KEPT) {
    const content = fs.readFileSync(path.join(LEGACY, name), 'utf8');
    const lines = (content.match(/\n/g) || []).length;
    total += lines;
    assert.equal(lines, EXPECT_LINES[name], `public/legacy/${name} 行数漂移（裁定 #2 常驻件零改动）`);
  }
  assert.equal(total, 1542, `4 件死锚点合计必须恰 1,542 行（双栈终局快照锚点；实测 ${total}）`);
});
