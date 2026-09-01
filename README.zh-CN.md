# FileEditor

[English](./README.md)

基于 Electron 的 VSCode 风格文件浏览器与编辑器 —— 单平台（macOS）MVP。以目录树浏览工作区，用 Monaco 查看/编辑文本与代码文件，预览图片，并实时显示 git 状态。

> 设计文档：[docs/electron-file-editor-design.md](./docs/electron-file-editor-design.md)（权威来源，覆盖架构、IPC 契约与 §1–§14 功能规格 + 附录 A）。发布/签名链路：[docs/ci-release-pipeline.md](./docs/ci-release-pipeline.md)。

## 功能特性

- **文件树浏览** —— 任意文件夹作为工作区打开；右键菜单新建 / 重命名 / 删除文件与文件夹；**把文件或文件夹拖到另一个文件夹上（或拖到树面板空白区域）即可移动**；复制绝对路径。
- **代码编辑** —— Monaco 编辑器（**离线打包**，不走 CDN），按文件缓存 model，脏标记，常见语言语法高亮。
- **图片预览** —— 常见格式（png / jpg / gif / webp / svg / bmp / ico），扩展名 + magic bytes 双校验。
- **预览范围** —— 支持文本类文件（txt / md / json / html / yaml / csv 及其他可解码源码）与图片；二进制格式（doc / docx / xlsx / ppt / pdf 等）明确不预览，显示友好提示而非乱码。
- **Git 状态高亮** —— 文件与目录显示修改 / 未跟踪 / 新增 / 删除角标（基于 `git status --porcelain`；非 git 仓库工作区不做装饰）。
- **外部改动实时同步** —— chokidar 监听工作区；外部修改刷新目录树，冲突时先询问再覆盖未保存内容。
- **可靠编辑三件套**（产品决策 —— 不做崩溃恢复 / 会话恢复）：
  - **关闭提示保存** —— 有关闭未保存文件时弹「保存 / 不保存 / 取消」。
  - **自动定时保存（可选）** —— 在设置中开启后按间隔静默保存脏标签（`localStorage` 持久化）。
  - **会话内撤销 / 重做** —— 工具栏按钮接 Monaco 的 per-model 撤销栈。
- **可拖拽分栏** —— 侧栏与编辑区之间的分隔条可自由拉伸（最小 160px）。
- **主题系统** —— 暗色 / 亮色双主题（TRAE IDE 风格配色）；可用工具栏按钮切换，或跟随系统 `prefers-color-scheme`。偏好持久化至 `localStorage`。

## 界面截图

所有截图统一存放于 [`docs/images/`](./docs/images/)，可随时通过 `node scripts/screenshots.mjs`（或 `pnpm screenshots`）重新生成 —— 脚本自动拉起 dev 实例、经 CDP 驱动界面并截取渲染进程画面。

| | |
|---|---|
| ![主界面](docs/images/screenshot-main.png) | ![图片预览](docs/images/screenshot-image-preview.png) |
| **主界面** —— 文件树 git 角标（M / A / U）、Monaco 编辑器与脏标记页签、底部状态栏 | **图片预览** —— png / jpg / gif / webp / svg / bmp / ico（扩展名 + magic bytes 双校验，§6.5） |

| | |
|---|---|
| ![不支持格式提示](docs/images/screenshot-unsupported.png) | ![设置面板](docs/images/screenshot-settings.png) |
| **不支持格式** —— 二进制文件显示友好提示而非乱码（§6.1 / §13） | **设置** —— 可选自动定时保存与间隔（§14） |

> 演示工作区由脚本在 `/tmp/eif-shot-ws` 从零重建，截图始终反映当前构建，且不会泄漏本地文件。

## 技术栈

- **Electron 44** + **electron-vite 5**（main / preload / renderer 三进程构建）
- **React 19** + **TypeScript 6** + **Vite 7**
- **Monaco Editor 0.56**（经 `?worker` 引入本地 worker）
- **chokidar 4**（文件监听）· **iconv-lite**（UTF-16 BOM 解码；工作区文本统一 UTF-8 无 BOM，见设计文档 §6.1）

## 快速开始

### 环境要求

- macOS（MVP 单平台）
- Node.js 22+
- pnpm 11+

### 安装

```bash
pnpm install
```

> **pnpm 11 构建脚本审批**：pnpm 默认拒绝执行依赖的安装期脚本。本仓库已在 `pnpm-workspace.yaml` 的 `allowBuilds` 中预批准 `electron` 与 `esbuild`（`electron-winstaller: false`，Windows 专用）。
>
> **⚠️ Electron ≥42 安装机制变更**：`electron@42` 起 package.json **移除了 postinstall 脚本**（安装器改由 `install-electron` bin 暴露），pnpm 的 allowBuilds 对其不再生效。本仓库已通过**项目自身的 lifecycle 脚本**根治——package.json `"postinstall": "node node_modules/electron/install.js"`，每次 `pnpm install` 自动补装平台二进制，无需手动执行。

### 运行

```bash
pnpm start             # 前台开发模式（electron-vite dev）
pnpm start --daemon    # 后台启动：日志写 log/dev-daemon.log，PID 写 pid/dev-daemon.pid
pnpm status            # 查看是否还在运行
pnpm stop              # 停止后台进程（终止整个进程组）
```

启动脚本会先剥离 `ELECTRON_RUN_AS_NODE` 再拉起 electron，任意 shell 环境均可直接使用。后台模式由常驻 supervisor 持有 PID 文件（`pid/dev-daemon.pid`），应用退出（如点窗口关闭）时自动清理，不会残留陈旧的 pid 文件。

## 命令一览

| 命令 | 作用 |
|---|---|
| `pnpm start` | 前台开发运行 |
| `pnpm start --daemon` | 后台开发运行（`log/dev-daemon.log` / `pid/dev-daemon.pid`） |
| `pnpm status` | 查询运行状态（pid 文件是否有效 / 存活进程 / 端口占用） |
| `pnpm stop` | 停止后台进程 |
| `pnpm dev` | 等价 `pnpm start`（原生 electron-vite dev） |
| `pnpm build` | 三进程构建到 `out/` |
| `pnpm preview` | 预览生产构建 |
| `pnpm dist` | 当前平台全架构打包（x64 + arm64，`scripts/dist.mjs`） |
| `pnpm dist:mac` / `dist:win` / `dist:linux` | 指定平台打包（dmg / NSIS exe / AppImage+deb），默认双架构 |
| `pnpm dist:mac:x64` 等 `:x64` / `:arm64` 后缀 | 仅构建指定架构 |
| `pnpm dist:all` | 全平台全架构（mac 仅限 macOS 主机，其余自动跳过） |
| `pnpm dist --email you@example.com` | 打包时指定邮箱（deb maintainer），默认 `rouroumaibing@qq.com` |
| `pnpm check` | **代码检查**：类型检查 + ESLint 一次跑完（`tsc --noEmit && eslint .`） |
| `pnpm typecheck` | 仅类型检查（`tsc --noEmit`） |
| `pnpm lint` | 仅 ESLint（`eslint .`） |
| `pnpm lint:fix` | ESLint 自动修复 |
| `pnpm e2e` | **UI 端到端测试** —— CDP 驱动真实 dev 实例（5 个场景：手动保存 / 重载二次确认 / 保留当前版本 / 自动保存 / clean 自动重载；零 npm 依赖，约 90–120s，见 `scripts/e2e/README.md`） |
| `pnpm screenshots` | 重新生成 `docs/images/` 下的截图（经 CDP 驱动真实 dev 实例，见 `scripts/screenshots.mjs`） |
| `pnpm clean` | 删除构建产物（`out/`、`dist/`） |
| `pnpm clean deep` | 额外删除 `node_modules/` 与 `pnpm-lock.yaml`（彻底重装） |

## 架构

```
src/
├── main/          # 主进程
│   ├── index.ts             # 窗口、关闭拦截、IPC 注册
│   ├── ipc/                 # fs / git IPC handlers
│   └── services/            # FileSystemService、GitStatusService
├── preload/       # contextBridge → window.fileAPI（带类型）
├── renderer/      # React 应用
│   ├── App.tsx              # 布局、标签页、watch 生命周期、模态框
│   ├── components/          # FileTree、CodeEditor、FilePreviewGate、ImageViewer、UnsupportedViewer、各模态框（Confirm/Input/CloseConfirm/Settings）
│   ├── hooks/useFileAPI.ts  # 类型化 IPC 客户端
│   ├── modelRegistry.ts     # Monaco model 缓存（按文件路径）
│   └── monacoSetup.ts       # Monaco 离线化 + 本地 worker
└── shared/types/  # IPC 契约类型（@shared 别名）
```

**安全模型**：`contextIsolation: true`、`nodeIntegration: false`、生产开启 sandbox（`sandbox: !isDev` —— dev 期关闭是因为未签名的 electron 二进制无法初始化 macOS App Sandbox）。所有特权操作经主进程的类型化 IPC handler 完成，渲染进程不直接触碰 Node API。

## 打包

```bash
pnpm dist             # 当前平台，双架构（x64 + arm64）
pnpm dist:mac         # → dist/FileEditor-*.dmg（x64 + arm64）
pnpm dist:mac:arm64   # 仅 Apple Silicon（另有 dist:mac:x64 / dist:win:x64 / dist:linux:arm64 等）
pnpm dist:all         # 全平台全架构（mac 仅限 macOS 主机）
pnpm dist --email you@example.com   # 指定 deb maintainer 邮箱（默认 rouroumaibing@qq.com）
```

三端 × 双架构（x64/arm64）全覆盖。macOS 产物只能在 macOS 上构建；win/linux 可交叉构建（可靠路径仍是 CI 三端矩阵）。项目无原生依赖，异构架构构建无需额外工具链。

macOS 打包在有签名证书时使用 hardened runtime + entitlements（`build/entitlements.mac.plist`）。无证书时 `dist.mjs` 自动降级为 **ad-hoc 签名**（`-c.mac.identity=-`，关闭 hardened runtime）——本机可运行，但外发时 Gatekeeper 显示「未识别开发者」（首次需右键 → 打开）。正式分发配 `CSC_LINK`/`CSC_KEY_PASSWORD`，公证再配 `APPLE_ID` 等，详见 `docs/ci-release-pipeline.md` 与 `.github/workflows/release-desktop.yml`（及 `build-mac.yml` / `build-windows.yml` / `build-linux.yml`）内注释。

## 文档

- [设计文档（中文）](./docs/electron-file-editor-design.md) —— 完整架构、IPC 契约、安全决策与逐功能规格。
- [发布与签名链路（中文）](./docs/ci-release-pipeline.md) —— CI 矩阵、macOS 签名/公证、产物核验。
- [E2E 测试指南](./scripts/e2e/README.md) —— CDP 端到端套件用法与 PIT 坑清单。
