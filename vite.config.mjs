// S2-1（React 重构 charter §5）→ P6-3：Vite 配置，放仓库根（D1）。
// - root=frontend；**base='/'**（D1'，P6-3）：HTML 源＝frontend/index.html（Vite HTML entry），
//   构建产出 public/index.html（入口 script 由 Vite 注入 `/app/entry.js`）——服务面 URL 与入场
//   逐字相同（`/` 与 `/app/entry.js`），驱动（tools/system-browser-acceptance.cjs 导航 `/`）
//   与静态壳 DOM 零改（P6-3 Plan §2.5 E1~E3 实测）。
// - build.outDir='../public' ＋ **emptyOutDir:false**（安全联锁，D2'，P6-3）：置 true 会清掉
//   public/legacy/**（4 件测试死锚点，灾难面，以 T2-3 钉住）。
//   entryFileNames 固定 'app/entry.js'（D2 沿革）：服务面引用固定路径 /app/entry.js，
//   vite 默认 hash 文件名会 404。
// - 样式表全部走构建：UI 优化阶段 5 起原 public/style.css 并入 frontend/styles/base.css（app.css 首个未分层 @import）。
// - dev 代理仅 5 条存量路径正则键（D3/D4 沿革）：/api（legacy 126 处绝对引用）、/legacy（36 个 script）、
//   /index.html、/style.css（阶段 5 后已无请求，键保留不动）、/favicon.ico（浏览器默认请求，404 透传无害）。
//   禁止 "/" 全局代理或 /app 代理：会拦截 dev server 自身资源（/@vite/client）与源模块请求，
//   破坏 HMR 与 React 壳加载。target 由 MOZHEN_DEV_ORIGIN 覆盖，默认隔离实例 3110。
// - Tailwind v4 经 @tailwindcss/vite 进构建（入口 frontend/styles/app.css）；扫描源与分层约束见该文件头注释。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'frontend',
  base: '/',
  plugins: [react(), tailwindcss()],
  publicDir: false,
  build: {
    outDir: '../public',
    // ⚠ 安全联锁（P6-3 Plan §1.2-5）：置 true 会清掉 public/legacy/**（4 件死锚点，
    // 灾难面）；红测 T2-3 钉住。
    emptyOutDir: false,
    assetsDir: 'app/assets',
    rollupOptions: {
      output: {
        entryFileNames: 'app/entry.js',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      ['^/(api|legacy|index\\.html|style\\.css|favicon\\.ico)(/|$|\\?)']: {
        target: process.env.MOZHEN_DEV_ORIGIN || 'http://127.0.0.1:3110',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.{js,mjs,jsx}'],
  },
})
