# 参与贡献

欢迎提交可复现的问题、写作场景建议、文档修正与聚焦的 Pull Request。讨论请保持尊重，尽量使用具体例子。

## 联系维护者

- 邮箱：[ther9527@163.com](mailto:ther9527@163.com)
- QQ 邮箱：[916994714@qq.com](mailto:916994714@qq.com)

一般问题和功能建议优先使用 Issues，便于检索与跟进。

## 问题与建议

先搜索 [已有 Issues](https://github.com/1while1/Plotforge/issues)，再选择问题反馈或功能建议模板。复现材料请使用虚构作品，隐去凭据、个人信息与真实正文。安全问题请按 [安全说明](SECURITY.md) 私密报告。

## 本地开发

推荐 Node.js 24.x。Fork 仓库后从最新 `dev` 建立功能分支，Pull Request 的目标分支选 `dev`，安装锁定依赖：

```bash
npm ci
npm run build
```

后端和 Vite 分别运行。下面是 bash / zsh 示例，后端使用独立临时库：

```bash
NOVEL_DB_FILE="$(mktemp -d)/dev.db" PORT=3110 npm start
# 另开终端
npm run dev
```

Windows PowerShell 可先设置环境变量：

```powershell
$env:NOVEL_DB_FILE = Join-Path ([IO.Path]::GetTempPath()) ("plotforge-dev-" + [guid]::NewGuid() + ".db")
$env:PORT = "3110"
npm start
# 另开终端运行 npm run dev
```

Vite 默认代理后端 `http://127.0.0.1:3110`，可通过 `MOZHEN_DEV_ORIGIN` 调整。前端源码位于 `frontend/`，不要修改构建产物 `public/app/`、`public/index.html` 或测试保留的 `public/legacy/`。

## 提交前验证

数据库测试应使用临时库，设置方式见 [README](README.md#测试)。按改动范围执行相关检查；CI 会执行：

```bash
npx biome check frontend
npm run build
npm test
npm run test:fe -- --no-file-parallelism
```

单测使用 mock，不需要真实模型密钥。真实模型 E2E 为单独的手动验证，不属于 CI。

PR 请说明问题、改动和实际验证结果。大型功能先开 Issue 对齐范围；公开发布会与上游开发同步，应用改动合入前需要核对发布来源。提交信息建议使用 `fix:`、`feat:`、`docs:`、`test:` 或 `chore:`。贡献按本仓库 [MIT 许可](LICENSE) 发布。

## 分支与稳定发布

`dev` 接收脱敏同步、功能改动和依赖更新，供验证与试用；`main` 保存维护者确认稳定的版本，仍是仓库默认分支。CI 通过是稳定晋级的必要条件，维护者还需确认实际使用稳定；工作流不会自动将 `dev` 合入 `main`。

稳定后，维护者把 `main` 快进到选定并通过 CI 的最新 `dev` 提交，保证两个分支引用同一份已验证代码，再按需创建版本标签与 Release。请使用快进发布流程，避免对 `dev` → `main` 使用 Squash 或 Rebase 合并而改变提交身份。
