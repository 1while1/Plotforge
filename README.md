# Plotforge

本地优先的 AI 小说创作工坊（墨砚）。一个跑在本机 Node.js 上的长篇小说写作环境：书籍、卷、章节三级结构，接入任意 OpenAI 兼容接口即可开始写作，所有数据保存在本地 SQLite 文件中。

## 功能

- **写作页流式对话**：按书互斥的聊天流闸门、断连即停、断点恢复，写作状态常显
- **大纲工作台**：章节时间轴、节拍（beat）编辑与拖拽排序、节奏热力条、缺口补章建议、AI 节奏评语、卷总结
- **参谋台（Agent）**：只读讨论模式与写作执行模式分离，工具面按场景白名单加载
- **人物 / 世界观 / 事件账本**：AI 只提案，人工采纳后才写入台账，带乐观锁与审计
- **上下文管理**：多 Provider 上下文预算管道、四节式会话压缩、来源快照过期检测
- **本地向量检索（RAG）**：章节正文自动切块建向量索引，Embedding 由本地模型完成（`@xenova/transformers`，不出本机），同书余弦 top-k 检索供上下文管道、证据搜索与 LLM 工具调用
- **风格仓库**：作家卡（人设 + 指纹 + 规则 + 范文）管理与体检
- **本地持久化**：sql.js（SQLite WASM）单文件数据库，含单实例锁与自动备份，无需外部服务

## 快速开始

要求 Node.js 18+。

```bash
npm install
npm run build   # 前端为 React + Vite，构建产物输出到 public/
npm start
```

打开 http://localhost:3000 ，在「设置」页填入你的 OpenAI 兼容接口参数（base_url / api_key / model）即可使用。

首次启动会下载本地 Embedding 模型（约 90MB，用于章节向量索引与检索），之后完全离线可用。

端口可用环境变量覆盖：`PORT=8080 npm start`。前端开发调试可用 `npm run dev`（Vite 热更新）。

## 示例数据

仓库不带任何真实作品。想快速体验各工作台，可以播种两部示例作品（各一卷四章，含人物与世界观条目）：

```bash
node tools/seed-demo.js
```

重复执行是安全的：同名书籍会被跳过。

## 测试

```bash
# 建议指向独立临时库，避免碰本地数据
NOVEL_DB_FILE=/tmp/qa.db npm test        # Windows PowerShell: $env:NOVEL_DB_FILE="C:\tmp\qa.db"
npm run test:fe                          # 前端组件测试（vitest）
```

## 技术栈

- 前端：React 19 + react-router + Vite（`frontend/`，构建产物经 Express 静态服务）
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

## License

[MIT](LICENSE)
