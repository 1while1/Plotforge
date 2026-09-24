// Skill 插件机制：扫描 skills/<name>/SKILL.md，解析 frontmatter，并执行其 Node CLI
// 与内置 websearch 模块并存：skill 走 CLI 子进程（可独立升级/替换），内置走原生 fetch
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

// 解析 SKILL.md frontmatter（--- 之间的 key: value）
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

// 列出已安装技能：[{ name, description, version, dir, cli }]
function listSkills() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const mdPath = path.join(SKILLS_DIR, d.name, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    let meta = {};
    try {
      meta = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
    } catch { /* 跳过坏文件 */ }
    const cli = path.join(SKILLS_DIR, d.name, 'scripts', 'anysearch_cli.js');
    out.push({
      name: meta.name || d.name,
      description: meta.description || '',
      version: meta.version || '',
      dir: path.join(SKILLS_DIR, d.name),
      cli: fs.existsSync(cli) ? cli : null,
    });
  }
  return out;
}

function getSkill(name) {
  return listSkills().find(s => s.name === name) || null;
}

// 执行 skill 的 Node CLI：runSkillCli('anysearch', ['search', '--query', '...']) → stdout
function runSkillCli(name, argv, timeoutMs = 40000) {
  const skill = getSkill(name);
  if (!skill) return Promise.reject(new Error(`技能「${name}」未安装（skills/${name} 不存在）`));
  if (!skill.cli) return Promise.reject(new Error(`技能「${name}」缺少可执行 CLI`));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [skill.cli, ...argv], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'skill 执行失败').slice(0, 300)));
      resolve(String(stdout || '').slice(0, 6000));
    });
  });
}

module.exports = { listSkills, getSkill, runSkillCli };
