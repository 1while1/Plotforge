// L2 结构化 LLM map 单测（方案 §3.2 schema 五硬约束 + §3.3 闸门 4 + 5 并发池 + JSONL 续跑）。
//
// 零真实网络：LLM 流量全部 stub 在 globalThis.fetch 边界（对齐 test/helpers/llm-stub.js
// 的 M5 mock 决策——只拦截 /chat/completions，其余 URL 透传原 fetch；key 一律
// 'sk-test-xxx' 假 key，本文件绝不读取真实 key 文件）。runMap 的词典与 JSONL 产物
// 全部落 mkdtempSync 临时目录（opts.dataRoot 注入），finally rmSync 清理。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const llm = require('../tools/distill/llm');
const map = require('../tools/distill/map');
const mask = require('../tools/distill/mask');
const util = require('../tools/distill/util');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'tools', 'distill.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'distill-map-test-'));

// ---------- fetch 边界 stub（非流式 chat.completions） ----------

function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('/chat/completions')) return orig(url, init);
    calls.push({ url: u, init, body: init && init.body ? JSON.parse(init.body) : null });
    return handler(calls.length - 1, init);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// chatJson 只走 res.ok + res.text() → 这里给最小 Response 形状（headers 可选，供 Retry-After 用例）
const jsonResponse = (data, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  ...(Object.keys(headers).length
    ? { headers: { get: (k) => headers[String(k).toLowerCase()] ?? headers[k] ?? null } }
    : {}),
  text: async () => JSON.stringify(data),
});

// ---------- extractJson ----------

test('extractJson：正常 JSON / ```json 围栏 / 前后杂文字', () => {
  assert.deepEqual(map.extractJson('{"observations":[]}'), { observations: [] });
  assert.deepEqual(
    map.extractJson('```json\n{"observations":[{"dim":"词汇"}]}\n```'),
    { observations: [{ dim: '词汇' }] }
  );
  assert.deepEqual(
    map.extractJson('好的，以下是分析结果：\n{"observations":[]}\n以上供参考。'),
    { observations: [] }
  );
  assert.deepEqual(map.extractJson('```\n{"a":1}\n```\n补充说明'), { a: 1 });
});

test('extractJson：烂输入一律返回 null', () => {
  for (const bad of ['', '   ', '完全不是 JSON', '{未闭合', '[]', 'null 文本', null, undefined, 42]) {
    assert.equal(map.extractJson(bad), null, `输入 ${JSON.stringify(bad)} 应返回 null`);
  }
});

// ---------- validateObservations（含闸门 4） ----------

const CHUNK = '他停下脚步，看了看远处的城郭。〔人名〕没有说话，风吹过树梢。';
const dictOf = (pairs) => ({ entries: pairs.map(([name, type]) => ({ name, type, count: 100 })) });

test('validateObservations：合法条目通过（trait 恰 80 码点边界；无 marker 则省略字段）', () => {
  const parsed = {
    observations: [
      { dim: '句法', trait: '多用短句收束段落', evidence: '他停下脚步，看了看远处的城郭。', count: 3, marker: '。' },
      { dim: '词汇', trait: '特'.repeat(80), evidence: '风吹过树梢', count: 1 },
    ],
  };
  const { kept, dropped } = map.validateObservations(parsed, CHUNK);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].marker, '。');
  assert.equal(kept[1].marker, undefined);
  assert.equal(util.codePoints(kept[1].trait), 80);
});

test('validateObservations：闸门 4——evidence 非掩码块文本逐字子串即丢弃并记 reason', () => {
  const parsed = {
    observations: [
      { dim: '句法', trait: '微改写证据', evidence: '他停下脚步，看了看远方的城郭。', count: 1 }, // 远处→远方
      { dim: '句法', trait: '跨段拼接证据', evidence: '他停下脚步，看了看远处的城郭。风吹过树梢，〔人名〕没有说话。', count: 1 }, // 拼接+调序
      { dim: '句法', trait: '首尾空白可容忍', evidence: ' 风吹过树梢 ', count: 1 },
    ],
  };
  const { kept, dropped } = map.validateObservations(parsed, CHUNK);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].trait, '首尾空白可容忍');
  assert.equal(kept[0].evidence, '风吹过树梢');
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason === 'evidence_not_substring'));
  assert.ok(dropped.every((d) => d.item && d.item.trait), 'dropped 须保留原条目供排查');
});

test('validateObservations：dim 白名单 / trait 非法 / count 非正整数 / 形状非法', () => {
  const cases = [
    [{ dim: '主题', trait: '维度不在七维白名单', evidence: '风吹过树梢', count: 1 }, 'dim_invalid'],
    [{ dim: '词汇', trait: '', evidence: '风吹过树梢', count: 1 }, 'trait_invalid'],
    [{ dim: '词汇', trait: '长'.repeat(81), evidence: '风吹过树梢', count: 1 }, 'trait_invalid'],
    [{ dim: '词汇', trait: 'count 是字符串', evidence: '风吹过树梢', count: '3' }, 'count_invalid'],
    [{ dim: '词汇', trait: 'count 为零', evidence: '风吹过树梢', count: 0 }, 'count_invalid'],
    [{ dim: '词汇', trait: 'count 是小数', evidence: '风吹过树梢', count: 1.5 }, 'count_invalid'],
    ['不是对象', 'shape_invalid'],
    [null, 'shape_invalid'],
  ];
  const { kept, dropped } = map.validateObservations({ observations: cases.map((c) => c[0]) }, CHUNK);
  assert.equal(kept.length, 0);
  assert.deepEqual(dropped.map((d) => d.reason), cases.map((c) => c[1]));
});

test('validateObservations：专名残留扫描——trait/evidence/marker 命中词典即丢（name_leak）', () => {
  const dict = dictOf([['城郭外', 'place'], ['远山', 'place']]);
  const parsed = {
    observations: [
      { dim: '描写', trait: '常以城郭外的远景开笔', evidence: '风吹过树梢', count: 2 }, // trait 泄漏
      { dim: '描写', trait: '正常特质', evidence: '风吹过树梢', count: 2, marker: '远山' }, // marker 泄漏
      { dim: '描写', trait: '干净特质', evidence: '风吹过树梢', count: 2 }, // 保留
    ],
  };
  const { kept, dropped } = map.validateObservations(parsed, CHUNK, dict);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].trait, '干净特质');
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason === 'name_leak'));
  // 不传 dict 时跳过残留扫描（宽容接口）
  const noDict = map.validateObservations(parsed, CHUNK);
  assert.equal(noDict.kept.length, 3);
});

test('validateObservations：parsed 为 null/裸数组 的宽容处理', () => {
  assert.deepEqual(map.validateObservations(null, CHUNK), { kept: [], dropped: [] });
  assert.deepEqual(map.validateObservations({}, CHUNK), { kept: [], dropped: [] });
  const asArray = map.validateObservations(
    [{ dim: '词汇', trait: '裸数组形态', evidence: '风吹过树梢', count: 1 }],
    CHUNK
  );
  assert.equal(asArray.kept.length, 1);
});

// ---------- SYSTEM_PROMPT / buildUserPrompt（防退化） ----------

test('SYSTEM_PROMPT：五条硬约束与输出格式俱全（防退化断言）', () => {
  const s = map.SYSTEM_PROMPT;
  for (const kw of ['逐字', '禁止情节摘要', '宁少勿凑', '可证伪', '文笔优美', '{"observations":[...]}', '80']) {
    assert.ok(s.includes(kw), `SYSTEM_PROMPT 须含「${kw}」`);
  }
  assert.deepEqual(map.DIMS, ['词汇', '句法', '标点', '对话', '描写', '叙事', '修辞']);
  for (const dim of map.DIMS) assert.ok(s.includes(dim), `SYSTEM_PROMPT 须含维度「${dim}」`);
});

test('SYSTEM_PROMPT：两条契约约束必须在（dim 原样中文 + JSON 内引号不得裸写）', () => {
  // 取证见报告 09 §6.10：这两条缺失分别导致 5,650 条观测被白名单丢弃、以及 JSON 解析失败类。
  // 钉子存在的意义：提示词是数据口径的一部分，被谁「顺手简化」掉就会重演这两类损失。
  const s = map.SYSTEM_PROMPT;
  assert.ok(/原样使用/.test(s), '须明确要求 dim 原样用七个中文标签');
  assert.ok(/vocabulary/.test(s), '须点名英文标签是错的（模型对「不要翻译」这句需要反例）');
  assert.ok(/未转义的双引号|不得出现未转义/.test(s), '须明确禁止字符串内裸写 ASCII 双引号');
  assert.ok(/解析失败/.test(s), '须写明违反的后果（模型对后果的服从度高于对规则的服从度）');
  // 七条硬约束（原五条 + 新增一条引号约束）——条数变化时强制回看这条钉子的意图
  const numbered = s.match(/^\d+\. /gm) || [];
  assert.equal(numbered.length, 6, `硬约束条数应为 6（实为 ${numbered.length}），增删前先确认不是退化`);
});

test('buildUserPrompt：含作者名、块文本与框界标记', () => {
  const up = map.buildUserPrompt(CHUNK, '测试甲');
  assert.ok(up.includes(CHUNK));
  assert.ok(up.includes('测试甲'));
  assert.ok(up.includes('====== 文本块开始 ======'));
  assert.ok(up.includes('====== 文本块结束 ======'));
});

// ---------- llm.js：masked / resolveApiKey / chatJson ----------

test('masked：前 8 后 4 掩码', () => {
  assert.equal(llm.masked('sk-test-1234567890abcdef'), 'sk-test-…cdef');
});

test('resolveApiKey：环境变量优先于 key 文件', () => {
  const tmp = tmpdir();
  const saved = process.env.STEPFUN_API_KEY;
  try {
    writeKeyFile(tmp, 'API Key：\nsk-test-file-xxxxxxxxxxxxxxxxxxxxxxxxxx\n');
    process.env.STEPFUN_API_KEY = 'sk-test-env-eeeeeeeeeeeeeeeeeeeeeeeee';
    assert.equal(llm.resolveApiKey({ root: tmp }), 'sk-test-env-eeeeeeeeeeeeeeeeeeeeeeeee');
    delete process.env.STEPFUN_API_KEY;
    assert.equal(llm.resolveApiKey({ root: tmp }), 'sk-test-file-xxxxxxxxxxxxxxxxxxxxxxxxxx');
  } finally {
    if (saved === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveApiKey：key 文件解析（「API Key：」行后首个 ≥30 非空行，跳过短行）', () => {
  const tmp = tmpdir();
  const saved = process.env.STEPFUN_API_KEY;
  try {
    delete process.env.STEPFUN_API_KEY;
    writeKeyFile(
      tmp,
      'StepFun 渠道说明\nAPI Key：\n这行是短说明不够长\nsk-test-file-abcdefghijklmnopqrstuvwxyz\n',
      'StepFun-APIKey.txt'
    );
    assert.equal(llm.resolveApiKey({ root: tmp }), 'sk-test-file-abcdefghijklmnopqrstuvwxyz');
  } finally {
    if (saved === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveApiKey：无环境变量且无可用 key 文件 → 抛错（提示设置环境变量，不泄 key）', () => {
  const tmp = tmpdir();
  const saved = process.env.STEPFUN_API_KEY;
  try {
    delete process.env.STEPFUN_API_KEY;
    const tmp2 = tmpdir();
    try {
      writeKeyFile(tmp2, '没有任何标记行\nsk-test-file-abcdefghijklmnopqrstuvwxyz\n');
      assert.throws(() => llm.resolveApiKey({ root: tmp2 }), /STEPFUN_API_KEY/);
    } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
    assert.throws(
      () => llm.resolveApiKey({ root: tmp }),
      (e) => /STEPFUN_API_KEY/.test(e.message) && !e.message.includes('sk-test')
    );
  } finally {
    if (saved === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('chatJson：正常路径——URL/授权头/超时 signal/usage/reasoningLength', async () => {
  const stub = stubFetch(() => jsonResponse({
    choices: [{
      message: { role: 'assistant', content: '{"observations":[]}', reasoning_content: '思考' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }));
  try {
    const out = await llm.chatJson({ apiKey: 'sk-test-xxx', body: { model: 'm1', max_tokens: 4000 } });
    assert.equal(out.content, '{"observations":[]}');
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { prompt_tokens: 100, completion_tokens: 20 });
    assert.equal(out.reasoningLength, 2);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.stepfun.com/step_plan/v1/chat/completions');
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer sk-test-xxx');
    assert.equal(stub.calls[0].body.model, 'm1');
    assert.ok(stub.calls[0].init.signal instanceof AbortSignal, '必须携带 AbortController signal');
  } finally {
    stub.restore();
  }
});

test('chatJson：content 空且 finish_reason=length → 抛错并提示调大 max_tokens', async () => {
  const stub = stubFetch(() => jsonResponse({
    choices: [{
      message: { role: 'assistant', content: '', reasoning_content: '想了很多' },
      finish_reason: 'length',
    }],
    usage: { prompt_tokens: 100, completion_tokens: 4000 },
  }));
  try {
    await assert.rejects(
      llm.chatJson({ apiKey: 'sk-test-xxx', body: { max_tokens: 4000 } }),
      (e) => /max_tokens/.test(e.message) && /调大/.test(e.message)
    );
  } finally {
    stub.restore();
  }
});

test('chatJson：HTTP 5xx 抛错供上层重试（错误不含 key）', async () => {
  const stub = stubFetch(() => jsonResponse({ error: 'boom' }, 502));
  try {
    await assert.rejects(
      llm.chatJson({ apiKey: 'sk-test-xxx', body: {} }),
      (e) => /HTTP 502/.test(e.message) && !e.message.includes('sk-test')
    );
  } finally {
    stub.restore();
  }
});

test('chatJson：429 携带 Retry-After → 挂 e.status / e.retryAfter（可重试）', async () => {
  const stub = stubFetch(() => jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '2' }));
  try {
    await assert.rejects(llm.chatJson({ apiKey: 'sk-test-xxx', body: {} }), (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 2000, 'retry-after 秒 → 毫秒');
      assert.equal(e.nonRetryable, undefined, '429 必须可重试');
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('chatJson：retry-after-ms 优先于 retry-after（网关常用毫秒头）', async () => {
  const stub = stubFetch(() => jsonResponse({}, 429, { 'retry-after-ms': '1500', 'retry-after': '99' }));
  try {
    await assert.rejects(llm.chatJson({ apiKey: 'sk-test-xxx', body: {} }),
      (e) => { assert.equal(e.retryAfter, 1500); return true; });
  } finally {
    stub.restore();
  }
});

test('chatJson：确定性错误标记 nonRetryable（401/400 与 length 耗尽）', async () => {
  const stub = stubFetch(() => jsonResponse({ error: 'bad key' }, 401));
  try {
    await assert.rejects(llm.chatJson({ apiKey: 'sk-test-xxx', body: {} }), (e) => {
      assert.equal(e.status, 401);
      assert.equal(e.nonRetryable, true, '401 重试纯浪费');
      return true;
    });
  } finally {
    stub.restore();
  }
  const stub2 = stubFetch(() => jsonResponse({
    choices: [{ message: { content: '', reasoning_content: '想了很多' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 100, completion_tokens: 4000 },
  }));
  try {
    await assert.rejects(llm.chatJson({ apiKey: 'sk-test-xxx', body: { max_tokens: 4000 } }), (e) => {
      assert.equal(e.nonRetryable, true, '同样的 body 重试必然同样耗尽预算');
      assert.equal(e.status, 400);
      return true;
    });
  } finally {
    stub2.restore();
  }
});

test('nextRetryDelay：确定性错误不重试；Retry-After 优先并夹顶；其余指数退避 + jitter', () => {
  assert.equal(map.nextRetryDelay({ nonRetryable: true }, 0, 2000), null);
  assert.equal(map.nextRetryDelay({ status: 429, retryAfter: 3000 }, 0, 2000), 3000);
  assert.equal(map.nextRetryDelay({ status: 429, retryAfter: 999999 }, 0, 2000), 60000, '夹在 60s 上限内');
  const d0 = map.nextRetryDelay({}, 0, 1000);
  const d1 = map.nextRetryDelay({}, 1, 1000);
  assert.ok(d0 >= 800 && d0 <= 1200, `1s ±20% jitter: ${d0}`);
  assert.ok(d1 >= 1600 && d1 <= 2400, `2s ±20% jitter: ${d1}`);
});

test('runPool：确定性错误只尝试一次；429 退避后重试可成功', async () => {
  let attempts = 0;
  const out = await map.runPool(
    [async () => { attempts++; const e = new Error('bad request'); e.nonRetryable = true; throw e; }],
    { concurrency: 1, retry: 3, baseDelayMs: 1 });
  assert.equal(attempts, 1, 'nonRetryable 不得重试');
  assert.equal(out[0].ok, false);

  let attempts2 = 0;
  const out2 = await map.runPool(
    [async () => {
      attempts2++;
      if (attempts2 === 1) { const e = new Error('rate limited'); e.status = 429; e.retryAfter = 1; throw e; }
      return 'ok';
    }],
    { concurrency: 1, retry: 2, baseDelayMs: 1 });
  assert.equal(attempts2, 2);
  assert.equal(out2[0].value, 'ok');
});

test('chatJson：超时用 AbortController 中止悬挂请求', async () => {
  // 永不 resolve 的悬挂响应，直到 init.signal abort 才 reject（尊重取消，同 llm-stub 习惯）
  const stub = stubFetch((i, init) => new Promise((resolve, reject) => {
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    const s = init && init.signal;
    if (!s) return reject(new Error('stub: 无 signal'));
    if (s.aborted) return onAbort();
    s.addEventListener('abort', onAbort, { once: true });
  }));
  try {
    await assert.rejects(llm.chatJson({ apiKey: 'sk-test-xxx', body: {}, timeoutMs: 60 }), /超时/);
  } finally {
    stub.restore();
  }
});

// ---------- runPool ----------

test('runPool：并发峰值恰为 5 且不越界，结果与任务同序', async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(15);
    active--;
    return i;
  });
  const out = await map.runPool(tasks, { concurrency: 5, retry: 1, baseDelayMs: 1 });
  assert.equal(out.length, 20);
  assert.ok(out.every((o) => o.ok));
  assert.deepEqual(out.map((o) => o.value), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(peak, 5, '5 个 worker 同步领任务后才睡——峰值必须恰为 5');
  assert.equal(active, 0);
});

test('runPool：失败任务原地重试后成功，重试不放大并发（峰值仍 ≤5）', async () => {
  let active = 0;
  let peak = 0;
  const attempts = [];
  const tasks = Array.from({ length: 12 }, (_, i) => {
    let n = 0;
    return async () => {
      attempts[i] = (attempts[i] || 0) + 1;
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      if (n++ === 0) throw new Error('第一次失败');
      return i;
    };
  });
  const out = await map.runPool(tasks, { concurrency: 5, retry: 3, baseDelayMs: 2 });
  assert.ok(out.every((o) => o.ok));
  assert.deepEqual(attempts, Array.from({ length: 12 }, () => 2), '每任务恰好 2 次尝试');
  assert.ok(peak <= 5, `重试等待期间并发峰值 ${peak} 不得超过 5`);
});

test('runPool：重试耗尽（默认 3 次重试 = 合计 4 次尝试）标记失败并回调 onDone(false)', async () => {
  const done = [];
  let calls = 0;
  const tasks = Array.from({ length: 3 }, () => async () => {
    calls++;
    throw new Error('永远失败');
  });
  const out = await map.runPool(tasks, { concurrency: 2, retry: 2, baseDelayMs: 1, onDone: (i, ok) => done.push([i, ok]) });
  assert.equal(calls, 9, '3 任务 × (1 初次 + 2 重试) = 9 次尝试');
  assert.ok(out.every((o) => !o.ok));
  assert.ok(out.every((o) => o.error && /永远失败/.test(o.error.message)));
  assert.equal(done.length, 3);
  assert.ok(done.every(([, ok]) => ok === false));
  assert.deepEqual(done.map((d) => d[0]).sort((a, b) => a - b), [0, 1, 2]);
});

test('runPool：默认参数 concurrency=5 / retry=3；空任务集返回空数组', async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 10 }, () => async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(8);
    active--;
  });
  const out = await map.runPool(tasks, { baseDelayMs: 1 }); // 不传 concurrency/retry
  assert.ok(out.every((o) => o.ok));
  assert.equal(peak, 5, '默认并发 5 应打满');
  let calls = 0;
  const out2 = await map.runPool([async () => { calls++; throw new Error('必败'); }], { baseDelayMs: 1 });
  assert.equal(calls, 4, '默认 retry=3 → 合计 4 次尝试');
  assert.equal(out2[0].ok, false);
  assert.deepEqual(await map.runPool([]), []);
});

// ---------- runMap 端到端（stub fetch + 临时目录） ----------

// 语料：单元句重复 400 行（~1.8 万字）→ 掩码后切 3 块（8,000/步长 7,800 口径）
const UNIT = '张三丰走在山道上，风吹过树梢。他停下脚步，看了看远处的城郭，随即又向前走去。';

function makeCorpus(tmp) {
  const corpusRoot = path.join(tmp, 'corpus');
  const bookDir = path.join(corpusRoot, '玄幻', '作家测试甲');
  fs.mkdirSync(bookDir, { recursive: true });
  const text = Array.from({ length: 400 }, (_, i) => UNIT + '（第' + i + '段）').join('\n');
  const bookPath = path.join(bookDir, '测试书.txt');
  fs.writeFileSync(bookPath, text, 'utf8');
  return { corpusRoot, bookPath, text };
}

function writeTmpDict(tmp, author, entries) {
  const p = path.join(tmp, 'data', 'corpus', 'dict', author, 'mask-dict.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 'v1-test',
    entries: entries.map(([name, type]) => ({ name, type, count: 100 })),
  }), 'utf8');
  return p;
}

function writeKeyFile(dir, content, name = 'StepFun蒸馏渠道apikey.txt') {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l)); // 任一行解析失败即测试失败：一行必须是一个合法 JSON
}

// 固定模型回包（```json 围栏，同时考验 extractJson 围栏剥离）：
//  - 条目1 合法（evidence 是掩码后单元句的逐字子串）
//  - 条目2 trait 含原专名 → name_leak（evidence 用占位符、本身合法）
//  - 条目3 evidence 不在原文 → 闸门 4 丢弃
const STUB_CONTENT = '```json\n' + JSON.stringify({
  observations: [
    { dim: '句法', trait: '动作句多以连动结构收尾', evidence: '他停下脚步，看了看远处的城郭，随即又向前走去。', count: 5, marker: '随即' },
    { dim: '对话', trait: '常以张三丰的连续动作代替对话推进场景', evidence: '〔人名〕走在山道上，风吹过树梢。', count: 5 },
    { dim: '标点', trait: '爱用波浪号制造语气', evidence: '~~这句话不在原文中~~', count: 2 },
  ],
}) + '\n```';

const stepOk = () => jsonResponse({
  choices: [{
    message: { role: 'assistant', content: STUB_CONTENT, reasoning_content: '思考过程略' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 8176, completion_tokens: 130 },
});

test('runMap：e2e——前 N 块落 JSONL / 请求体契约 / 二次运行 0 调用 / sha 变更重跑', async () => {
  const tmp = tmpdir();
  const stub = stubFetch(() => stepOk());
  try {
    const { corpusRoot, bookPath, text } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const dict = { entries: [{ name: '张三丰', type: 'person', count: 100 }] };

    // 用例自检：与 runMap 同口径（strip → mask → mapChunks）应为 3 块
    const allChunks = util.mapChunks(mask.maskText(util.stripChapterTitles(text), dict));
    assert.equal(allChunks.length, 3, '合成语料应切出 3 块（8,000 字/步长 7,800）');

    // ---- 第 1 轮：limit=2 → 2 次调用、2 行 JSONL ----
    const out1 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 2, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(
      Object.keys(out1).sort(),
      ['done', 'droppedObservations', 'failed', 'keptObservations', 'skipped', 'splitBlocks', 'total', 'usageTokens', 'wallMs']
    );
    assert.equal(out1.total, 2);
    assert.equal(out1.done, 2);
    assert.equal(out1.failed, 0);
    assert.equal(out1.skipped, 0);
    assert.equal(out1.keptObservations, 2);   // 每块保留 1 条
    assert.equal(out1.droppedObservations, 4); // 每块丢 2 条（name_leak + 闸门4）
    assert.deepEqual(out1.usageTokens, { input: 2 * 8176, output: 2 * 130 });

    // 请求体契约：渠道参数 + 掩码后文本进 prompt + 系统提示词
    const b = stub.calls[0].body;
    assert.equal(b.model, map.MODEL);
    assert.equal(b.reasoning_effort, map.REASONING_EFFORT);
    assert.equal(b.max_tokens, map.MAX_TOKENS);
    assert.equal(b.messages[0].role, 'system');
    assert.equal(b.messages[0].content, map.SYSTEM_PROMPT);
    assert.ok(b.messages[1].content.includes('〔人名〕走在山道上'), 'user prompt 必须是掩码后文本');
    assert.ok(!b.messages[1].content.includes('张三丰'), 'user prompt 不得残留原专名');
    assert.ok(b.messages[1].content.includes('测试甲'));
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer sk-test-xxx');

    const jsonl = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl');
    const lines1 = readJsonl(jsonl);
    assert.equal(lines1.length, 2);
    assert.deepEqual(lines1.map((l) => l.chunkIndex).sort((a, x) => a - x), [0, 1]);
    for (const l of lines1) {
      assert.equal(l.sha256, util.sha256(allChunks[l.chunkIndex].text), 'sha256 须为掩码后块文本的摘要');
      assert.ok(l.at);
      assert.equal(l.kept.length, 1);
      assert.equal(l.kept[0].dim, '句法');
      assert.equal(l.kept[0].marker, '随即');
      assert.equal(l.dropped.length, 2);
      assert.deepEqual(
        l.dropped.map((d) => d.reason).sort(),
        ['evidence_not_substring', 'name_leak']
      );
    }

    // ---- 第 2 轮：同 scope 重跑 → 0 次 LLM 调用、全部跳过、JSONL 不变 ----
    stub.calls.length = 0;
    const out2 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 2, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(stub.calls.length, 0, '已完成块（sha 一致）不得再调 LLM');
    assert.equal(out2.total, 2);
    assert.equal(out2.done, 0);
    assert.equal(out2.skipped, 2);
    assert.equal(out2.keptObservations, 2, '跳过块的在档观测计入汇总');
    assert.equal(out2.droppedObservations, 4);
    assert.deepEqual(out2.usageTokens, { input: 0, output: 0 });
    assert.equal(readJsonl(jsonl).length, 2);

    // ---- 第 3 轮：放开 limit → 只补第 3 块 ----
    stub.calls.length = 0;
    const out3 = await map.runMap(corpusRoot, { author: '测试甲', dataRoot: tmp, apiKey: 'sk-test-xxx' });
    assert.equal(out3.total, 3);
    assert.equal(out3.done, 1);
    assert.equal(out3.skipped, 2);
    assert.equal(stub.calls.length, 1);
    assert.equal(readJsonl(jsonl).length, 3);

    // ---- 第 4 轮：改语料开头 → chunk0 sha 变更 → 重跑并追加（后行覆盖前行）----
    fs.writeFileSync(bookPath, '这是一段后来加上的引言，用来改变全文哈希。' + text + '\n', 'utf8');
    stub.calls.length = 0;
    const out4 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(out4.total, 1);
    assert.equal(out4.done, 1);
    assert.equal(out4.skipped, 0);
    assert.equal(stub.calls.length, 1, 'sha 不一致的块必须重跑');
    assert.equal(readJsonl(jsonl).length, 4, '重跑为追加而非改写：3 + 1 行');

    // 后行覆盖语义：再跑同 scope → 0 调用（新 sha 已在档）
    stub.calls.length = 0;
    const out5 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(out5.done, 0);
    assert.equal(out5.skipped, 1);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('JSONL 残行隔离：上次崩溃留下的无换行残片不会吞掉新记录', async () => {
  // 缺陷：写一行的中途崩溃 → 文件尾留无换行残片 → 下次 append 与残片拼成一行，
  // 该行 JSON.parse 失败被整行忽略（新记录一并丢失 + 多一次重复计费）。
  const tmp = tmpdir();
  const stub = stubFetch(() => stepOk());
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const mapDir = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map');
    fs.mkdirSync(mapDir, { recursive: true });
    const jsonl = path.join(mapDir, '测试书.jsonl');
    fs.writeFileSync(jsonl, '{"chunkIndex":9,"sha256":"deadbe', 'utf8'); // 半行残片

    const out1 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(out1.done, 1);
    const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2, '残片应被隔离成独立一行，新记录另起一行');
    assert.throws(() => JSON.parse(lines[0]), '残片仍是腐败行（既有「腐败行忽略」语义）');
    const rec = JSON.parse(lines[1]);
    assert.equal(rec.chunkIndex, 0);
    assert.equal(rec.sha256.length, 64, '新记录必须完整（未被残片吞并）');

    // 新记录在档 → 续跑 0 调用（残片不影响完成集判定）
    stub.calls.length = 0;
    const out2 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(out2.skipped, 1);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMap：输出预算耗尽（finish_reason=length）→ 切半分块重算，观测合并落同一行', async () => {
  // 2026-09-13 真机实测：8,000 字块在 max_tokens=12000 下会整块被思考吃光（12 块里 2 块），
  // 若把它当「该块失败」，全量跑就会永久缺这些块的数据。切半后正文减半、预算宽裕。
  const tmp = tmpdir();
  const trunc = () => jsonResponse({
    choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考把预算吃光了' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 8000, completion_tokens: 12000 },
  });
  const stub = stubFetch((i) => (i === 0 ? trunc() : stepOk()));
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const out = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
    });
    assert.equal(stub.calls.length, 3, '整块 1 次 + 两半各 1 次');
    assert.equal(out.done, 1);
    assert.equal(out.failed, 0);
    assert.equal(out.splitBlocks, 1);
    const rows = readJsonl(path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl'));
    assert.equal(rows.length, 1, '切分不产生多行——续跑按父块 sha 判定，多行会让父块永远重算');
    assert.equal(rows[0].splits, 1, '留痕：该块被切分过几次');
    assert.equal(rows[0].kept.length, 2, '两半各保留 1 条，合并');
    // 成本口径：被放弃的那次调用（12000 输出 token）也是真花钱，必须计入 usage
    assert.equal(rows[0].usage.output, 12000 + 130 + 130);
    assert.equal(rows[0].usage.input, 8000 + 8176 + 8176);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMap：解析失败且非截断（finish_reason=stop）→ 不切分，照旧走失败路径', async () => {
  // 切分兜底只针对「预算耗尽」这一类；模型返回垃圾文本必须仍报失败，避免把噪声当数据。
  const tmp = tmpdir();
  const stub = stubFetch(() => jsonResponse({
    choices: [{ message: { role: 'assistant', content: '这不是 JSON' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }));
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const out = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx', retry: 0,
    });
    assert.equal(out.failed, 1);
    assert.equal(out.splitBlocks, 0);
    assert.equal(stub.calls.length, 1, '不切分 → 只有原始那一次调用');
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI 参数校验：--limit / --concurrency 非法或缺值一律拒绝（不再静默全量跑）', () => {
  // 缺陷：--limit 0 / --limit abc 因 falsy 判断静默退化为「全量跑」——误输入即全量 LLM 计费。
  const tmp = tmpdir();
  try {
    const { corpusRoot } = makeCorpus(tmp);
    const run = (args) => spawnSync(process.execPath, [CLI, 'map', corpusRoot, ...args], { encoding: 'utf8' });
    for (const args of [
      ['--author', '测试甲', '--limit', '0'],
      ['--author', '测试甲', '--limit', 'abc'],
      ['--author', '测试甲', '--concurrency', '-1'],
      ['--author', '测试甲', '--max-tokens', '0'],
      ['--author', '测试甲', '--max-tokens', 'abc'],
    ]) {
      const r = run(args);
      assert.equal(r.status, 1, `应拒绝 ${args.join(' ')}（stdout=${r.stdout} stderr=${r.stderr}）`);
      assert.ok(/必须为正整数/.test(r.stderr), r.stderr);
    }
    const missing = run(['--author', '测试甲', '--limit']);
    assert.equal(missing.status, 1);
    assert.ok(/缺少取值/.test(missing.stderr), missing.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMap：缺词典 / 缺 author / 语料无匹配 均显式报错', async () => {
  const tmp = tmpdir();
  try {
    const { corpusRoot } = makeCorpus(tmp);
    await assert.rejects(
      map.runMap(corpusRoot, { author: '测试甲', dataRoot: tmp, apiKey: 'sk-test-xxx' }),
      (e) => /词典/.test(e.message) && /mask/.test(e.message)
    );
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    await assert.rejects(
      map.runMap(corpusRoot, { dataRoot: tmp, apiKey: 'sk-test-xxx' }),
      /author/
    );
    await assert.rejects(
      map.runMap(corpusRoot, { author: '不存在的人', dataRoot: tmp, apiKey: 'sk-test-xxx' }),
      /没有匹配/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('解析失败：不落 JSONL、计 failed、续跑仍会重试（不再被当作已完成）', async () => {
  // 核查修复的缺陷：解析失败此前只 console.warn 后照常落一行 kept=0 —— 该块在文件层面
  // 与「模型确实没给出观测」不可区分，续跑时 sha 命中被永久跳过、不重试也不报错。
  const tmp = tmpdir();
  // finish_reason=stop：模型吐了垃圾文本 ≠ 预算耗尽。截断（length）走切分兜底，
  // 垃圾文本必须仍按失败处理（切分只会把噪声切成更多噪声）。
  const badReply = () => jsonResponse({
    choices: [{ message: { content: '这不是 JSON，只是一段说明' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  const stub = stubFetch(badReply);
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const jsonl = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl');

    const out1 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx', retry: 1, baseDelayMs: 1,
    });
    assert.equal(out1.done, 0);
    assert.equal(out1.failed, 1, '重试耗尽 → 计入 failed');
    assert.equal(out1.failed + out1.done + out1.skipped, out1.total, 'done+failed+skipped=total');
    assert.equal(stub.calls.length, 2, 'retry=1 → 共 2 次尝试');
    assert.equal(fs.existsSync(jsonl), false, '解析失败的块不得落行（落行 = 续跑永久跳过）');

    // 第二轮：仍会重试（不是「已完成」），失败继续被计数
    stub.calls.length = 0;
    const out2 = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx', retry: 0, baseDelayMs: 1,
    });
    assert.equal(stub.calls.length, 1, '失败块在下一轮必须重试');
    assert.equal(out2.failed, 1);
    assert.equal(fs.existsSync(jsonl), false);

    // 恢复正常回包 → 该块可正常完成（失败不污染后续运行）
    stub.calls.length = 0;
    stub.restore();
    const stub2 = stubFetch(() => stepOk());
    try {
      const out3 = await map.runMap(corpusRoot, {
        author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
      });
      assert.equal(out3.done, 1);
      assert.equal(out3.failed, 0);
      assert.equal(readJsonl(jsonl).length, 1);
    } finally {
      stub2.restore();
    }
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('长跑可观测性：失败即时打印 + 心跳行（静默卡住与正常推进可区分）', async () => {
  // 2026-09-13 主代理据「一段时间没有新行」误判过一次卡住，实际是正常推进（每块约 30s，
  // 25 块的进度行要等约 12 分钟才出现）——失败又只在整个 pool 结束后才打印，两者叠加
  // 让日志无法自证「还活着」。本钉子锁住：失败逐条即时打印、心跳按 heartbeatMs 定期打印。
  const tmp = tmpdir();
  // 让每次请求慢于心跳间隔（25ms > 5ms），否则整轮在心跳前就跑完了
  const badReply = () => new Promise((r) => setTimeout(
    () => r(jsonResponse({
      choices: [{ message: { content: '不是 JSON' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })), 25));
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m) => logs.push(String(m));
  console.error = (m) => errs.push(String(m));
  const stub = stubFetch(badReply);
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    await map.runMap(corpusRoot, {
      author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx',
      retry: 0, baseDelayMs: 1, heartbeatMs: 5,
    });
    assert.ok(errs.some((l) => /本轮重试耗尽/.test(l)),
      '失败必须即时打印（不等全跑完的汇总）: ' + JSON.stringify(errs));
    assert.ok(logs.some((l) => /心跳: 完成 /.test(l)),
      '必须有心跳行（含完成数/总数）: ' + JSON.stringify(logs));
  } finally {
    console.log = origLog;
    console.error = origErr;
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 渠道注册 / 多 key 轮转（2026-09-13 加 Agnes 官方线） ----------
// 背景：map 从单渠道（StepFun）扩为双渠道。Agnes 官方线有三处与 StepFun 不同：
//   ① 开思考要 chat_template_kwargs.enable_thinking（走 buildBody 分叉）；
//   ② 无 reasoning_effort；
//   ③ 凭据文件里 6 把独立额度 key（RPM 各 20）→ 需要轮转（keyRotator）。

test('providerOf：省略=StepFun（默认行为不变）；agnes 有独立 baseUrl；未知名字抛错不静默回退', () => {
  assert.equal(llm.providerOf().name, 'stepfun');
  assert.equal(llm.providerOf(undefined).baseUrl, llm.BASE_URL);
  const a = llm.providerOf('agnes');
  assert.equal(a.baseUrl, 'https://apihub.agnes-ai.com/v1');
  assert.equal(a.defaultModel, 'agnes-3.0-flash');
  assert.equal(a.multiKey, true);
  assert.throws(() => llm.providerOf('openai'), /未知渠道/);
});

test('resolveApiKeys：凭据文件里的多把 sk-/wk- key 全取出（去重）', () => {
  const tmp = tmpdir();
  const saved = process.env.AGNES_API_KEY;
  try {
    delete process.env.AGNES_API_KEY;
    writeKeyFile(tmp,
      'Agnes 渠道上游 Key：\n\n' +
      'Agnes-1：sk-test-pool-aaaaaaaaaaaaaaaaaa\n' +
      'Agnes-2：sk-test-pool-bbbbbbbbbbbbbbbbbb\n' +
      'Agnes-3：wk-test-pool-cccccccccccccccccc\n' +
      'Agnes-4：sk-test-pool-aaaaaaaaaaaaaaaaaa\n' +   // 故意重复 → 必须去重
      '\n官方 Base：https://apihub.agnes-ai.com/v1\n',
      'Agens的key.txt');
    const keys = llm.resolveApiKeys('agnes', { root: tmp });
    assert.equal(keys.length, 3, '3 把不同 key（重复项去重）: ' + JSON.stringify(keys.map(llm.masked)));
    assert.ok(keys.every((k) => /^[sw]k-test-pool-/.test(k)));
  } finally {
    if (saved === undefined) delete process.env.AGNES_API_KEY;
    else process.env.AGNES_API_KEY = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveApiKeys：环境变量优先且支持逗号分隔多把；无凭据时抛错且不泄 key 内容', () => {
  const tmp = tmpdir();
  const saved = process.env.AGNES_API_KEY;
  try {
    process.env.AGNES_API_KEY = 'sk-test-env-1, sk-test-env-2';
    assert.deepEqual(llm.resolveApiKeys('agnes', { root: tmp }), ['sk-test-env-1', 'sk-test-env-2']);
    delete process.env.AGNES_API_KEY;
    assert.throws(
      () => llm.resolveApiKeys('agnes', { root: tmp }),
      (e) => /AGNES_API_KEY/.test(e.message) && !e.message.includes('sk-test')
    );
  } finally {
    if (saved === undefined) delete process.env.AGNES_API_KEY;
    else process.env.AGNES_API_KEY = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('keyRotator：环形轮转、size=key 数、空数组抛错', () => {
  const next = llm.keyRotator(['k1', 'k2', 'k3']);
  assert.equal(next.size, 3);
  assert.deepEqual([next(), next(), next(), next(), next()], ['k1', 'k2', 'k3', 'k1', 'k2']);
  assert.throws(() => llm.keyRotator([]), /至少需要一把/);
  assert.throws(() => llm.keyRotator(['', '  ']), /至少需要一把/);
});

test('buildBody：stepfun 带 reasoning_effort；agnes 带 chat_template_kwargs.enable_thinking 且不带 reasoning_effort', () => {
  const messages = [{ role: 'user', content: '块文本' }];
  const s = map.buildBody({ provider: llm.providerOf('stepfun'), model: map.MODEL, maxTokens: 16000, messages });
  assert.equal(s.reasoning_effort, map.REASONING_EFFORT);
  assert.equal(s.chat_template_kwargs, undefined);
  assert.equal(s.max_tokens, 16000);
  const a = map.buildBody({ provider: llm.providerOf('agnes'), model: 'agnes-3.0-flash', maxTokens: 16000, messages });
  assert.deepEqual(a.chat_template_kwargs, { enable_thinking: true });
  assert.equal(a.reasoning_effort, undefined, 'Agnes 无 reasoning_effort 参数');
  assert.equal(a.model, 'agnes-3.0-flash');
});

test('chatJson：provider=agnes → 打到官网 base；错误文案用 Agnes 标签且不含 key', async () => {
  const stub = stubFetch(() => jsonResponse({ error: { message: 'upstream' } }, 503));
  try {
    await assert.rejects(
      () => llm.chatJson({ apiKey: 'sk-test-xxx', body: {}, provider: 'agnes' }),
      (e) => /Agnes HTTP 503/.test(e.message) && !e.message.includes('sk-test')
    );
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://apihub.agnes-ai.com/v1/chat/completions');
  } finally {
    stub.restore();
  }
});

test('runMap：provider=agnes → 请求体开思考 + 多 key 轮转 + 落行带 provider/model 溯源', async () => {
  const tmp = tmpdir();
  const stub = stubFetch(() => stepOk());
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const out = await map.runMap(corpusRoot, {
      author: '测试甲', limit: 3, dataRoot: tmp, concurrency: 1,
      provider: 'agnes', apiKeys: ['sk-test-k1', 'sk-test-k2'],
    });
    assert.equal(out.done, 3);
    assert.equal(out.failed, 0);
    const b = stub.calls[0].body;
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: true });
    assert.equal(b.reasoning_effort, undefined);
    assert.equal(b.model, 'agnes-3.0-flash');
    // 并发=1 → 调用顺序确定：k1,k2,k1
    assert.deepEqual(
      stub.calls.map((c) => c.init.headers.Authorization),
      ['Bearer sk-test-k1', 'Bearer sk-test-k2', 'Bearer sk-test-k1']
    );
    const rows = readJsonl(path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl'));
    assert.ok(rows.length === 3);
    assert.ok(rows.every((r) => r.provider === 'agnes' && r.model === 'agnes-3.0-flash'),
      '每行必须自证渠道与模型: ' + JSON.stringify(rows.map((r) => [r.provider, r.model])));
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DEFAULT_TIMEOUT_MS：单次调用超时定稿 300s（120s 过紧的实测钉子）', () => {
  // 2026-09-13 双线实测：Agnes 线延迟 P90 124s / 峰值 145s，「请求超时」是两线第一大失败因
  // （20 次超时 vs 6 次内容审查 451）。此钉子防有人把超时改回小值而不自知。
  assert.equal(map.DEFAULT_TIMEOUT_MS, 300000);
});

// ---------- 闸门 4 空白不敏感复核（第 2.5 步，离线零 LLM） ----------

test('validateObservations：ignoreWhitespace——仅空白差异放行并标 relaxed，拼接/改写仍拒', () => {
  const chunk = '第一段。 \n　　第二段：〔人名〕说道，“走吧”。\n　　第三段无空白差异。';
  const mk = (evidence) => ({ observations: [{ dim: '词汇', trait: '高频双音节动词', evidence, count: 2 }] });

  // ① 严格口径：模型把「。 」后的空格与换行缩进规范化掉 → 拒
  const wsDiff = '第二段：〔人名〕说道，“走吧”。第三段无空白差异。';
  assert.equal(map.validateObservations(mk(wsDiff), chunk, null).kept.length, 0);
  assert.equal(map.validateObservations(mk(wsDiff), chunk, null).dropped[0].reason, 'evidence_not_substring');

  // ② 放宽口径：放行，且条目带 relaxed:'whitespace' 留痕（严格口径可从数据重建）
  const v = map.validateObservations(mk(wsDiff), chunk, null, { ignoreWhitespace: true });
  assert.equal(v.kept.length, 1);
  assert.equal(v.kept[0].relaxed, 'whitespace');
  assert.equal(v.dropped.length, 0);

  // ③ 放宽口径仍拦得住：中间多出非空白字符（跨段拼接/改写）
  const stitched = '第二段：〔人名〕说道，他笑了，走吧。第三段无空白差异。';
  assert.equal(map.validateObservations(mk(stitched), chunk, null, { ignoreWhitespace: true }).kept.length, 0);
  // ④ 默认不开（不传 opts 时行为与历史一致）
  assert.equal(map.validateObservations(mk(wsDiff), chunk, null, {}).kept.length, 0);
  assert.equal(map.stripWhitespace(chunk).includes(map.stripWhitespace(wsDiff)), true);
});

test('revalidateMap：严格保留项是放宽保留项的子集；产物写 map-relaxed/ 且原 JSONL 不动', async () => {
  const tmp = tmpdir();
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const dict = { version: 'v1-test', entries: [{ name: '张三丰', type: 'person', count: 100 }] };
    const text = fs.readFileSync(path.join(corpusRoot, '玄幻', '作家测试甲', '测试书.txt'), 'utf8');
    const chunks = util.mapChunks(mask.maskText(util.stripChapterTitles(text), dict));

    // 造一行：1 条严格命中 + 1 条仅空白差异（把原文的换行缩进改成直连）+ 1 条拼接（两者都拒）
    const c = chunks[0];
    const seg = c.text.slice(200, 240).replace(/[\s\u3000]+/g, '');     // 去空白的真实片段
    const strictEv = c.text.slice(100, 140);
    const jsonl = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl');
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.writeFileSync(jsonl, JSON.stringify({
      chunkIndex: 0, sha256: util.sha256(c.text), at: new Date().toISOString(),
      provider: 'stepfun', model: 'step-3.7-flash', usage: { input: 1, output: 2 },
      kept: [{ dim: '词汇', trait: '严格命中项', evidence: strictEv, count: 1 }],
      dropped: [
        { item: { dim: '句法', trait: '空白差异项', evidence: seg, count: 2 }, reason: 'evidence_not_substring' },
        { item: { dim: '修辞', trait: '拼接项', evidence: '这里拼接了不存在的中间内容' + seg.slice(0, 8), count: 1 }, reason: 'evidence_not_substring' },
      ],
    }) + '\n', 'utf8');
    const before = fs.readFileSync(jsonl, 'utf8');

    const out = map.revalidateMap(corpusRoot, { author: '测试甲', dataRoot: tmp });
    assert.equal(out.totals.rows, 1);
    assert.equal(out.totals.stale, 0);
    assert.equal(out.totals.keptBefore, 1);
    assert.equal(out.totals.keptAfter, 2, '空白差异项应被补回');
    assert.equal(out.totals.recovered, 1);
    assert.equal(out.totals.droppedAfter, 1, '拼接项仍应被拒');
    const relaxed = readJsonl(path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map-relaxed', '测试书.jsonl'));
    assert.equal(relaxed[0].policy, 'ws-insensitive+dims-normalized');
    assert.equal(relaxed[0].kept.filter((k) => k.relaxed === 'whitespace').length, 1);
    assert.equal(relaxed[0].kept.some((k) => k.trait === '严格命中项' && !k.relaxed), true, '严格命中项不该被标 relaxed');
    assert.equal(fs.readFileSync(jsonl, 'utf8'), before, '原 JSONL 必须一字不动');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('revalidateMap：sha 不一致的旧行跳过（词表重建后不能拿今天的块文本复核）', () => {
  const tmp = tmpdir();
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const jsonl = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl');
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.writeFileSync(jsonl, JSON.stringify({
      chunkIndex: 0, sha256: 'deadbeef'.repeat(8), at: new Date().toISOString(), kept: [], dropped: [],
    }) + '\n', 'utf8');
    const out = map.revalidateMap(corpusRoot, { author: '测试甲', dataRoot: tmp });
    assert.equal(out.totals.rows, 0);
    assert.equal(out.totals.stale, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMap：默认渠道仍写 provider=stepfun / model=step-3.7-flash（缺字段旧行的口径注释有据）', async () => {
  const tmp = tmpdir();
  const stub = stubFetch(() => stepOk());
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    await map.runMap(corpusRoot, { author: '测试甲', limit: 1, dataRoot: tmp, apiKey: 'sk-test-xxx' });
    const rows = readJsonl(path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl'));
    assert.equal(rows[0].provider, 'stepfun');
    assert.equal(rows[0].model, 'step-3.7-flash');
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 维度标签别名归一（第 2.5 步之二：Agnes 侧把七个维度写成英文） ----------

test('DIM_ALIASES：表结构自洽——目标一定是七个中文标签之一，键一定不在白名单里', () => {
  const dims = new Set(map.DIMS);
  for (const [alias, target] of Object.entries(map.DIM_ALIASES)) {
    assert.ok(dims.has(target), `${alias} → ${target} 不是白名单维度`);
    assert.ok(!dims.has(alias), `${alias} 本身就是白名单维度，不该出现在别名表里（会掩盖真实冲突）`);
  }
  // 钉子：白名单七项与方案 §3.2 一致（表/白名单同时漂移时这条会响）
  assert.deepEqual(map.DIMS, ['词汇', '句法', '标点', '对话', '描写', '叙事', '修辞']);
});

test('normalizeDim：原样命中 / 别名命中（大小写与空白不敏感）/ 猜不出返回 null', () => {
  assert.equal(map.normalizeDim('词汇'), '词汇');
  assert.equal(map.normalizeDim('vocabulary'), '词汇');
  assert.equal(map.normalizeDim('Vocabulary'), '词汇');
  assert.equal(map.normalizeDim('  syntax  '), '句法');
  assert.equal(map.normalizeDim('narration'), '叙事');
  assert.equal(map.normalizeDim('句式'), '句法');
  // 唯一读法原则：styl 在七维里有多个可能读法 → 不猜（宁可少回收一条）
  assert.equal(map.normalizeDim('styl'), null);
  assert.equal(map.normalizeDim('情感'), null);
  assert.equal(map.normalizeDim(null), null);
  assert.equal(map.normalizeDim(42), null);
});

test('validateObservations：normalizeDims 只修标签，不放宽证据/计数（闸门 4 不受影响）', () => {
  // 块里刻意保留换行与全角缩进：⑤ 要用它造出「仅空白差异」的证据
  const chunk = '第一段。〔人名〕说道，“走吧”。\n　　这里有足够的原文用于逐字引用与计数。';
  const ev = chunk.slice(4, 20);
  const en = (extra = {}) => ({ observations: [{ dim: 'vocabulary', trait: '高频动词', evidence: ev, count: 3, ...extra }] });

  // ① 严格口径：英文标签判 dim_invalid（生成侧仍只认七个中文标签）
  const strict = map.validateObservations(en(), chunk, null);
  assert.equal(strict.kept.length, 0);
  assert.equal(strict.dropped[0].reason, 'dim_invalid');

  // ② 归一口径：放行，dim 被改写为中文，且标 relaxed:'dim' 留痕
  const norm = map.validateObservations(en(), chunk, null, { normalizeDims: true });
  assert.equal(norm.kept.length, 1);
  assert.equal(norm.kept[0].dim, '词汇');
  assert.equal(norm.kept[0].relaxed, 'dim');

  // ③ 归一不放宽闸门 4：英文标签 + 证据不是子串 → 照样拒
  const bad = map.validateObservations({ observations: [{ dim: 'vocabulary', trait: 'x', evidence: '这段原文不在块里', count: 1 }] },
    chunk, null, { normalizeDims: true });
  assert.equal(bad.kept.length, 0);
  assert.equal(bad.dropped[0].reason, 'evidence_not_substring');

  // ④ 归一不放宽计数：count 非正整数 → count_invalid
  const badCount = map.validateObservations(en({ count: 0 }), chunk, null, { normalizeDims: true });
  assert.equal(badCount.kept.length, 0);
  assert.equal(badCount.dropped[0].reason, 'count_invalid');

  // ⑤ 两个开关同时命中 → 标签是组合值（下游可据此分辨补回原因）
  //    注意 evidence 的**首尾**空白会被先剪掉，要造出空白差异必须动内部空白：
  //    取一段跨换行/缩进的原文，把内部空白全部去掉（与真实模型行为一致）。
  const nl = chunk.indexOf('\n');
  const srcSeg = nl > 5 ? chunk.slice(nl - 12, nl + 10) : chunk.slice(0, 24);
  const wsEv = srcSeg.replace(/[\s\u3000]+/g, '');
  const both = map.validateObservations({ observations: [{ dim: 'syntax', trait: 'y', evidence: wsEv, count: 2 }] },
    chunk, null, { ignoreWhitespace: true, normalizeDims: true });
  assert.equal(both.kept.length, 1);
  assert.equal(both.kept[0].relaxed, 'whitespace+dim');
  assert.equal(both.kept[0].dim, '句法');

  // ⑥ 默认不开（不传 opts）时行为与历史一致：英文标签一律丢
  assert.equal(map.validateObservations(en(), chunk, null, {}).kept.length, 0);
});

test('revalidateMap：英文维度标签被补回并计入 recoveredBy.dim，产物 policy 双口径留痕', () => {
  const tmp = tmpdir();
  try {
    const { corpusRoot } = makeCorpus(tmp);
    writeTmpDict(tmp, '测试甲', [['张三丰', 'person']]);
    const dict = { version: 'v1-test', entries: [{ name: '张三丰', type: 'person', count: 100 }] };
    const text = fs.readFileSync(path.join(corpusRoot, '玄幻', '作家测试甲', '测试书.txt'), 'utf8');
    const c = util.mapChunks(mask.maskText(util.stripChapterTitles(text), dict))[0];
    const ev = c.text.slice(100, 140);
    const jsonl = path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map', '测试书.jsonl');
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.writeFileSync(jsonl, JSON.stringify({
      chunkIndex: 0, sha256: util.sha256(c.text), at: new Date().toISOString(),
      provider: 'agnes', model: 'agnes-3.0-flash', usage: { input: 1, output: 2 },
      kept: [],
      dropped: [
        { item: { dim: 'punctuation', trait: '感叹号密度高', evidence: ev, count: 5 }, reason: 'dim_invalid' },
        { item: { dim: 'styl', trait: '猜不出读法', evidence: ev, count: 5 }, reason: 'dim_invalid' },
      ],
    }) + '\n', 'utf8');

    const out = map.revalidateMap(corpusRoot, { author: '测试甲', dataRoot: tmp });
    assert.equal(out.totals.keptBefore, 0);
    assert.equal(out.totals.keptAfter, 1, '英文标签项应被补回');
    assert.equal(out.totals.recoveredBy.dim, 1);
    assert.equal(out.totals.recoveredBy.whitespace, undefined);
    const rows = readJsonl(path.join(tmp, 'data', 'corpus', 'src-测试甲', 'map-relaxed', '测试书.jsonl'));
    assert.equal(rows[0].policy, 'ws-insensitive+dims-normalized');
    assert.equal(rows[0].kept[0].dim, '标点');
    assert.equal(rows[0].kept[0].relaxed, 'dim');
    assert.equal(rows[0].dropped.length, 1, 'styl 这种猜不出的仍应被拒');
    assert.equal(rows[0].dropped[0].reason, 'dim_invalid');

    // 关掉 dims 归一（--no-dims）时回到纯空白口径：这条不该被补回
    const onlyWs = map.revalidateMap(corpusRoot, { author: '测试甲', dataRoot: tmp, normalizeDims: false });
    assert.equal(onlyWs.totals.keptAfter, 0);
    assert.equal(onlyWs.policy, 'ws-insensitive+dims-strict');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
