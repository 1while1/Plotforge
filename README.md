# Plotforge

[![CI](https://github.com/1while1/Plotforge/actions/workflows/ci.yml/badge.svg)](https://github.com/1while1/Plotforge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/1while1/Plotforge)](https://github.com/1while1/Plotforge/releases/latest)
[![License](https://img.shields.io/github/license/1while1/Plotforge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24-417e38)](https://nodejs.org/)

本地优先的 AI 小说创作工坊（墨砚）。一个跑在本机 Node.js 上的长篇小说写作环境：书籍、卷、章节三级结构，接入任意 OpenAI 兼容接口即可开始写作，所有数据保存在本地 SQLite 文件中。

## 功能

- **写作工作台**：章节栏、正文编辑区与 AI 面板协作，专注模式保留正文与底部 AI 输入栏，窄屏侧栏可通过抽屉打开
- **外观与快捷操作**：亮色 / 暗色 / 跟随系统主题，主色、正文字体与行宽可调整；`Ctrl+K` 快速跳转，支持保存、切章、定稿与专注模式快捷键
- **写作页流式对话**：按书互斥的聊天流闸门、断连即停、断点恢复，写作状态常显；回复按服务端意图区分正文与讨论，正文插入后自动保存，对话贴底跟随
- **大纲工作台**：章节时间轴、节拍（beat）编辑与拖拽排序、节奏热力条、缺口补章建议、AI 节奏评语、卷总结
- **参谋台（Agent）**：只读讨论模式与写作执行模式分离，工具面按场景白名单加载
- **人物 / 世界观 / 事件账本**：AI 只提案，人工采纳后才写入台账，带乐观锁与审计
- **上下文管理**：多 Provider 上下文预算管道、四节式会话压缩、连续压缩继承摘要、来源快照过期检测，按会话查看调用用量与上下文组成
- **BYOK 服务商与模型管理**：添加服务商、编辑密钥与模型列表、切换活动模型；密钥保存在本机服务端数据库，配置接口只返回掩码
- **本地向量检索（RAG）**：章节正文自动切块建向量索引，Embedding 由本地模型完成（`@xenova/transformers`，不出本机），同书余弦 top-k 检索供上下文管道、证据搜索与 LLM 工具调用
- **风格仓库**：作家卡（人设 + 指纹 + 规则 + 范文）管理与体检
- **本地持久化**：sql.js（SQLite WASM）单文件数据库，含单实例锁与自动备份，无需外部服务

## 快速开始

推荐 Node.js 24.x；也支持 Node.js 22.13+（22.x）或 26+。

从 [最新 Release](https://github.com/1while1/Plotforge/releases/latest) 下载源码并解压，进入项目目录后运行：

```bash
npm ci
npm run build   # 前端为 React + Vite，构建产物输出到 public/
npm start
```

打开 http://localhost:3000 ，在「设置 → 模型接口」添加 OpenAI 兼容服务商（接口地址、API Key 与模型列表），再激活要使用的模型即可开始写作。

首次启动会下载本地 Embedding 模型（约 90MB，用于章节向量索引与检索），之后完全离线可用。

端口可用环境变量覆盖：`PORT=8080 npm start`。前端开发调试可用 `npm run dev`（Vite 热更新），代理默认连接 `http://127.0.0.1:3110`，可用 `MOZHEN_DEV_ORIGIN` 指定后端地址。

## 示例数据

仓库不带任何真实作品。想快速体验各工作台，可以播种两部示例作品（各一卷四章，含人物与世界观条目）：

```bash
node tools/seed-demo.js
```

重复执行是安全的：同名书籍会被跳过。也可用 `npm run seed`；设置 `NOVEL_DB_FILE` 可将示例播种到独立临时库。

## 测试

```bash
# 建议指向独立临时库，避免碰本地数据（bash / zsh）
NOVEL_DB_FILE="$(mktemp -d)/qa.db" npm test
npm run test:fe  # 前端组件测试（vitest）
```

Windows PowerShell：

```powershell
$env:NOVEL_DB_FILE = Join-Path ([IO.Path]::GetTempPath()) ("plotforge-qa-" + [guid]::NewGuid() + ".db")
npm test
npm run test:fe
Remove-Item Env:NOVEL_DB_FILE
```

## 技术栈

- 前端：React 19 + react-router + Vite，Tailwind CSS 4 与 Radix UI（`frontend/`，构建产物经 Express 静态服务）
- 后端：Node.js + Express 5，sql.js（SQLite WASM）持久化到 `data/novel.db`
- 检索：`@xenova/transformers` 本地 Embedding + 余弦检索（`server/vector/`），向量存于同一份 SQLite 库
- LLM：OpenAI 兼容协议，设置页可切换服务商与模型

## 目录结构

```
frontend/  React 单页应用源码（页面 / 组件 / hooks / lib）
public/    前端构建产物与静态资源
server/    Express 路由、领域服务、上下文管道、LLM 网关、工具系统
test/      node:test 单元与集成测试
tools/     播种、备份、蒸馏等命令行工具
```

## 版本与参与

- [正式版本与下载](https://github.com/1while1/Plotforge/releases) · [更新记录](CHANGELOG.md)
- [问题反馈与功能建议](https://github.com/1while1/Plotforge/issues/new/choose) · [贡献指南](CONTRIBUTING.md)
- [安全说明与私密漏洞报告](SECURITY.md)

正式版本以 `v主版本.次版本.补丁版本` 标签标记，下载时优先使用最新稳定 Release。当前提供源码，需要按上面的步骤安装依赖并构建。

## License

[MIT](LICENSE)
