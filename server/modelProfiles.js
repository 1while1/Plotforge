// BYOK「服务商配置」（model profiles）：settings 里的一层附加数据。
// 激活某个配置 = 把它的 base_url/api_key/model/context_window 复制进既有活动设置键，
// server/llm.js 的读取路径保持不变（llmConfig 只认那四个键）。
const crypto = require('crypto');
const db = require('./db');
const urlGuard = require('./urlGuard');
const { llmConfig } = require('./llm');

const PROFILES_KEY = 'model_profiles';
const ACTIVE_KEY = 'active_model_profile';

const NAME_MAX = 40;
const MODEL_MAX_LEN = 120;
const MODELS_MAX = 50;
const CTX_MIN = 8000;
const CTX_MAX = 2000000;

// 内置渠道：name/base_url 不可改（份额焊死），api_key/models/context_window 可编辑。
const BUILTINS = [
  {
    id: 'paid',
    name: '付费渠道（zen/go）',
    base_url: 'https://opencode.ai/zen/go/v1',
    key_optional: false,
    models: ['deepseek-v4-flash'],
  },
  {
    id: 'free',
    name: '免费渠道（zen）',
    base_url: 'https://opencode.ai/zen/v1',
    key_optional: true,
    models: ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free', 'north-mini-code-free'],
  },
  {
    id: 'agnes',
    name: 'Agnes（apihub）',
    base_url: 'https://apihub.agnes-ai.com/v1',
    key_optional: false,
    models: ['agnes-2.5-flash', 'agnes-2.5-pro', 'agnes-2.0-flash', 'agnes-2.5-pro-alpha'],
  },
  {
    id: 'stepfun',
    name: 'StepFun 官方（step_plan）',
    base_url: 'https://api.stepfun.com/step_plan/v1',
    key_optional: false,
    models: ['step-3.7-flash', 'step-3.5-flash'],
  },
];
const BUILTIN_IDS = new Set(BUILTINS.map(b => b.id));

function readSetting(key) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : undefined;
}

function writeSetting(key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

// 与 routes/settings.js 的掩码规则逐字一致（那边是本模块的调用方，为免循环依赖在此复刻）
function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return '';
  if (apiKey.length < 10) return '***';
  return apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
}

function stripTrailingSlash(url) {
  return String(url == null ? '' : url).replace(/\/+$/, '');
}

function stringModels(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function pickSetting(key, fallback) {
  const value = readSetting(key);
  return value === undefined || value === '' ? fallback : value;
}

function currentBaseUrl() {
  return stripTrailingSlash(pickSetting('base_url', llmConfig().baseUrl));
}

function currentModel() {
  return pickSetting('model', llmConfig().model);
}

function newBuiltin(def, previous) {
  return {
    id: def.id,
    name: def.name,
    builtin: true,
    key_optional: def.key_optional,
    base_url: def.base_url,
    api_key: previous ? previous.api_key : '',
    models: previous && previous.models.length ? previous.models : def.models.slice(),
    context_window: previous ? previous.context_window : '',
  };
}

function toProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    builtin: raw.builtin === true,
    key_optional: raw.key_optional === true,
    base_url: stripTrailingSlash(typeof raw.base_url === 'string' ? raw.base_url : ''),
    api_key: typeof raw.api_key === 'string' ? raw.api_key : '',
    models: stringModels(raw.models),
    context_window: raw.context_window == null ? '' : String(raw.context_window),
  };
}

// 坏 JSON / 空值一律视为「未播种」，避免一条脏数据锁死整个设置页
function parseStored() {
  const raw = readSetting(PROFILES_KEY);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(toProfile).filter(Boolean);
  } catch {
    return null;
  }
}

// 首次运行：以当前活动设置反向播种——命中内置渠道则把 key/model/窗口灌进去并设为活动；
// 否则建一条「当前自定义」，保证升级后用户不会看到空列表、也不会丢当前渠道。
function seedFromActiveSettings() {
  const llm = llmConfig();
  const baseUrl = stripTrailingSlash(pickSetting('base_url', llm.baseUrl));
  const apiKey = pickSetting('api_key', llm.apiKey);
  const model = pickSetting('model', llm.model);
  const contextWindow = readSetting('context_window') || '';
  const profiles = BUILTINS.map(def => newBuiltin(def, null));
  const hit = baseUrl ? profiles.find(p => p.base_url === baseUrl) : null;
  if (hit) {
    hit.api_key = apiKey;
    if (model && !hit.models.includes(model)) hit.models.push(model);
    hit.context_window = contextWindow;
    return { profiles, activeId: hit.id };
  }
  if (baseUrl) {
    const custom = {
      id: 'custom-1',
      name: '当前自定义',
      builtin: false,
      key_optional: false,
      base_url: baseUrl,
      api_key: apiKey,
      models: model ? [model] : [],
      context_window: contextWindow,
    };
    profiles.push(custom);
    return { profiles, activeId: custom.id };
  }
  return { profiles, activeId: '' };
}

// 读取 + 自愈：内置渠道必须齐全且排在前（自定义保持原有相对顺序）
function loadProfiles() {
  const stored = parseStored();
  let seeded = null;
  let base = [];
  if (stored === null) {
    seeded = seedFromActiveSettings();
    base = seeded.profiles;
  } else {
    base = stored;
  }
  const byId = new Map(base.map(p => [p.id, p]));
  const customs = base
    .filter(p => !BUILTIN_IDS.has(p.id))
    .map(p => ({ ...p, builtin: false }));
  let repaired = false;
  const builtins = BUILTINS.map(def => {
    const previous = byId.get(def.id);
    if (!previous) repaired = true;
    return newBuiltin(def, previous || null);
  });
  const profiles = builtins.concat(customs);
  if (seeded !== null) {
    saveProfiles(profiles);
    if (seeded.activeId) writeSetting(ACTIVE_KEY, seeded.activeId);
  } else if (repaired) {
    saveProfiles(profiles);
  }
  return profiles;
}

function saveProfiles(profiles) {
  writeSetting(PROFILES_KEY, JSON.stringify(profiles));
}

// 活动判定：存的活动 id 仍与当前 base_url 一致才算数（用户可能绕过本模块直接改设置），
// 否则回退到「第一个 base_url 相同的配置」，再否则 null。
function activeProfileId(profiles) {
  const baseUrl = currentBaseUrl();
  if (!baseUrl) return null;
  const stored = readSetting(ACTIVE_KEY);
  const storedProfile = stored ? profiles.find(p => p.id === stored) : null;
  if (storedProfile && storedProfile.base_url === baseUrl) return storedProfile.id;
  const first = profiles.find(p => p.base_url === baseUrl);
  return first ? first.id : null;
}

function maskProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    builtin: profile.builtin,
    key_optional: profile.key_optional,
    base_url: profile.base_url,
    api_key_set: !!profile.api_key,
    api_key_masked: maskApiKey(profile.api_key),
    models: profile.models.slice(),
    context_window: profile.context_window,
  };
}

function listPayload() {
  const profiles = loadProfiles();
  return {
    profiles: profiles.map(maskProfile),
    active_profile_id: activeProfileId(profiles),
    active_model: currentModel(),
  };
}

function cleanName(value) {
  const name = String(value == null ? '' : value).trim();
  if (!name || name.length > NAME_MAX) throw new Error('名称不能为空（最多 40 字）');
  return name;
}

function cleanBaseUrl(value) {
  const baseUrl = stripTrailingSlash(String(value == null ? '' : value).trim());
  if (!baseUrl) throw new Error('base_url 不能为空');
  urlGuard.assertPublicBaseUrl(baseUrl, { label: 'base_url' });
  return baseUrl;
}

function cleanModels(value) {
  if (!Array.isArray(value)) throw new Error('至少保留一个模型名');
  const models = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const model = item.trim();
    if (!model) continue;
    if (model.length > MODEL_MAX_LEN) throw new Error(`模型名不能超过 ${MODEL_MAX_LEN} 字`);
    if (!models.includes(model)) models.push(model);
  }
  if (models.length === 0) throw new Error('至少保留一个模型名');
  if (models.length > MODELS_MAX) throw new Error(`模型名最多 ${MODELS_MAX} 个`);
  return models;
}

function cleanContextWindow(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (text === '') return '';
  const message = `context_window 需为 ${CTX_MIN}~${CTX_MAX} 的整数，留空表示自动`;
  if (!/^\d+$/.test(text)) throw new Error(message);
  const n = Number(text);
  if (n < CTX_MIN || n > CTX_MAX) throw new Error(message);
  return String(n);
}

function assertUniqueName(profiles, name, selfId) {
  const lower = name.toLowerCase();
  const clash = profiles.some(p => p.id !== selfId && String(p.name).trim().toLowerCase() === lower);
  if (clash) throw new Error('名称已存在，请换一个');
}

function createProfile(body = {}) {
  const profiles = loadProfiles();
  const name = cleanName(body.name);
  assertUniqueName(profiles, name, null);
  const profile = {
    id: `p_${crypto.randomBytes(4).toString('hex')}`,
    name,
    builtin: false,
    key_optional: false,
    base_url: cleanBaseUrl(body.base_url),
    api_key: body.api_key == null ? '' : String(body.api_key).trim(),
    models: cleanModels(body.models),
    context_window: cleanContextWindow(body.context_window),
  };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

// 活动配置的设置回写：模型列表变更后若当前模型已不在列，切到列表首个（否则激活态指向一个不存在的模型）
function syncActiveSettings(profile) {
  writeSetting('base_url', profile.base_url);
  writeSetting('api_key', profile.api_key);
  writeSetting('context_window', profile.context_window);
  if (!profile.models.includes(currentModel())) writeSetting('model', profile.models[0]);
  writeSetting(ACTIVE_KEY, profile.id);
}

function updateProfile(id, body = {}) {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return null;
  // 先算活动态：改了 base_url 之后再算就对不上了
  const wasActive = activeProfileId(profiles) === profile.id;
  if (!profile.builtin) {
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      assertUniqueName(profiles, name, profile.id);
      profile.name = name;
    }
    if (body.base_url !== undefined) profile.base_url = cleanBaseUrl(body.base_url);
  }
  if (body.models !== undefined) profile.models = cleanModels(body.models);
  if (body.context_window !== undefined) profile.context_window = cleanContextWindow(body.context_window);
  if (body.api_key !== undefined) {
    const text = String(body.api_key).trim();
    if (!(text === '' && body.clear_api_key !== true)) profile.api_key = text;
  }
  saveProfiles(profiles);
  if (wasActive) syncActiveSettings(profile);
  return profile;
}

function deleteProfile(id) {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return { error: 'NOT_FOUND' };
  if (profile.builtin) return { error: '内置渠道不能删除' };
  if (activeProfileId(profiles) === profile.id) return { error: '正在使用的服务商不能删除，请先切换' };
  const next = profiles.filter(p => p.id !== id);
  saveProfiles(next);
  return { ok: true };
}

function activateProfile(id, model) {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return { error: 'NOT_FOUND' };
  const wanted = String(model == null ? '' : model).trim();
  if (!profile.models.includes(wanted)) return { error: '该服务商下没有这个模型' };
  if (!profile.api_key && !profile.key_optional) return { error: '该服务商还没有配置 API Key' };
  // 空串是有效值（免费渠道无 key），必须显式写库，不能走 PUT /api/settings 的「空串忽略」规则
  writeSetting('base_url', profile.base_url);
  writeSetting('model', wanted);
  writeSetting('api_key', profile.api_key);
  writeSetting('context_window', profile.context_window);
  writeSetting(ACTIVE_KEY, profile.id);
  return { ok: true };
}

// 设置页「上下文窗口」仍走 PUT /api/settings：同步进活动配置，否则下次切模型会被配置里的旧值覆盖
function syncContextWindowToActive(value) {
  const profiles = loadProfiles();
  const id = activeProfileId(profiles);
  const profile = id ? profiles.find(p => p.id === id) : null;
  if (!profile) return;
  const text = value == null ? '' : String(value).trim();
  if (profile.context_window === text) return;
  profile.context_window = text;
  saveProfiles(profiles);
}

module.exports = {
  syncContextWindowToActive,
  loadProfiles,
  listPayload,
  maskProfile,
  activeProfileId,
  createProfile,
  updateProfile,
  deleteProfile,
  activateProfile,
  maskApiKey,
};
