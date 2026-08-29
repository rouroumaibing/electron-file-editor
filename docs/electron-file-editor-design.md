# electron-file-editor 设计文档（v5 · 按代码二次核验版）

> **范围**：file-editor 项目（Electron 本地文件浏览 + 代码编辑）的完整设计——架构、契约、安全、数据流、性能、交互、工程化。
> **版本**：v5 二次核验（2026-08-30 18:25）。本文档**逐条对照 `src/`（28 个文件）、`scripts/`（5 个脚本 + e2e）、`package.json`、`electron-builder.yml`、`electron.vite.config.ts`、`pnpm-workspace.yaml`、`.gitignore`、`.github/workflows/`（5 个 workflow）实际代码核验重写**，不再保留任何未经代码证实的表述。
> **备份记录**：重写前曾将 v3/v4 各版临时备份至 `docs/archive/`（防止重写中断），v5 完成后已按用户要求删除，历史版本以 git 记录为准。
> **v5 核验结论（诚实记录）**：v4 已与代码高度一致，本次核验逐文件比对后**仅修正少量事实差异**（见附录 A「v4→v5」：目录结构补 `e2e/README.md`；补 §11.4 e2e 套件说明；更新 §14.2 快照）。凡未列出修正的章节，表示 v4 表述与代码逐条相符——**代码未变，文档不改**，避免为改而改引入臆想。
> **配套文档**：发布/签名链路独立成文 `docs/ci-release-pipeline.md`（本文 §12 引用，不重复展开；该文档已与 `.github/workflows/` 全部 5 个 workflow 及 `dist.mjs` / `verify-artifacts.mjs` 逐条核对一致，本次核验确认无需改动）。
> **代码注释中的章节引用**：源码注释里仍存在 `§14`、`§15`、`§17`、`§3.6b` 等**历史编号**（对应更早文档版本），与本文档章节号不完全对应。本文档以自身章节为准，代码注释如需精确指向，请按附录 A 的语义映射自行换算，不要按字面章节号查找。

---

## 1. 产品定位与设计原则

### 1.1 定位

本地文件浏览器 + 代码编辑器：文件树浏览、多标签文本编辑、Git 状态装饰。支持 Mac / Windows / Linux（打包矩阵见 §12.1，macOS 为主战场）。

- **本地优先**：生产运行路径物理级离线（页面经 `file://` 加载，全代码库无任何发起外网请求的调用点；Monaco 已本地化，§7.1）。更新走「源码重建（开发者）」与「手动下载安装包（终端用户）」两种模式，边界定义见 `docs/ci-release-pipeline.md §6.5`，本应用**不内置**自动更新。
- **查看 + 编辑**：不是 IDE。明确不做崩溃恢复、会话恢复、Office/PDF 渲染（见 §13.3 非目标清单）。

### 1.2 设计原则

1. **不重复造轮子**：文件系统访问用 Node.js 原生能力；编辑器内核直接复用 Monaco（VSCode 同款）；自研部分只有文件树 UI、IPC 胶水层与冲突/事件处理。
2. **安全默认**：渲染进程零 Node 权限；所有文件操作经主进程 containment 校验（§4）。
3. **契约先行、代码为真源**：共享类型统一放 `src/shared/types/fs.ts` / `src/shared/types/git.ts`（经 `@shared` 别名被 main/preload/renderer 三方引用，`tsconfig.json` paths + `electron.vite.config.ts` 三处 alias 双配置）。文档描述语义与决策，不复制两份漂移的类型。
4. **可移植**：UI 组件只依赖 `window.fileAPI` 抽象，不直接 `import('electron')`，为"未来转插件"预留（§13.1）。
5. **可验证**：每个实现批次有明确验收门禁（§14），文档规定即实现的强制要求，不搞"写了没落地"。

### 1.3 关键技术栈（对照 package.json 实际版本）

| 层 | 选型（实际版本） | 说明 |
|---|---|---|
| 应用外壳 | Electron ^44 | `contextIsolation` + `sandbox`（生产）；preload 依赖 `webUtils.getPathForFile`（Electron 44 中 `File.path` 已移除，§10.6） |
| 前端框架 | React ^19 + TypeScript ^6 | `jsx: react-jsx`；TS 6 起 `baseUrl` 废弃，`paths` 相对 tsconfig 目录解析 |
| 编辑器内核 | `monaco-editor` ^0.56 + `@monaco-editor/react` ^4.7 | 已离线化（本地 loader + 本地 worker，§7.1）；monaco 0.53+ 走 package.json exports 映射（`.//*` → `./esm/vs/*.js`） |
| 文件树组件 | 自研（`FileTree.tsx`） | VSCode 未拆出开源文件树库，必须自己写 |
| 文件系统访问 | Node `fs.promises` + `chokidar` ^4 | chokidar 4 抹平各平台差异；**chokidar 4 已移除 `useFsEvents` 选项**（macOS 恒用 FSEvents，§5.6） |
| 文本解码 | `iconv-lite` ^0.7 | 仅 BOM 明确的 UTF-16 解码用（§6.2） |
| IPC | `ipcMain` / `ipcRenderer` + `contextBridge` | 严格白名单，绝不暴露整个 `ipcRenderer` |
| 打包分发 | `electron-builder` ^26 | 三端安装包一套配置（§12） |
| 构建 | `electron-vite` ^5 + `vite` ^7 | 三进程构建；dev 期注入 `ELECTRON_RENDERER_URL` 与 `NODE_ENV_ELECTRON_VITE=development` |

---

## 2. 系统架构

### 2.1 三进程模型

Electron 应用分为三个隔离的运行环境，这是安全性和可维护性的基础：

```
┌─────────────────────────────────────────────────────────────┐
│ Main Process (Node.js)                                        │
│  - 完整系统权限：fs 读写、chokidar 监听、对话框、剪贴板          │
│  - 文件操作全部封装在 FileSystemService / GitStatusService      │
│  - 所有能力通过 IPC 按需开放，不直接暴露给前端                   │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC (ipcMain / ipcRenderer)
                        │ 经 preload.js 桥接，contextIsolation 隔离
┌───────────────────────┴─────────────────────────────────────┐
│ Renderer Process (Chromium)                                   │
│  - 无 Node.js 权限（安全默认）                                 │
│  - UI 层：FileTree + Monaco + 模态框/状态栏                    │
│  - 只能通过 preload 暴露的白名单 fileAPI 调用主进程能力          │
└─────────────────────────────────────────────────────────────┘
```

**为什么必须这样分层**：Renderer 本质是网页环境，若直接把 Node 能力挂 `window`（关掉 `contextIsolation`），一旦编辑器打开含恶意脚本的文件预览触发 XSS，就有远程代码执行风险。这是 Electron 官方安全指南第一条红线，从项目一开始就按隔离模式搭。

**BrowserWindow 配置**（`src/main/index.ts`）：

```typescript
new BrowserWindow({
  width: 1200,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'), // main→out/main/，preload→out/preload/
    contextIsolation: true,   // 必须开启
    nodeIntegration: false,   // 必须关闭
    sandbox: !isDev,          // 生产开启（dev 例外见下）
  },
});
```

> **dev 期 sandbox 例外**：macOS App Sandbox 要求 app 带 entitlements 签名才能初始化；`pnpm dev` 跑的是 node_modules 里未签名未打包的 electron 二进制，`sandbox:true` 在 Mac 上必报 `sandbox initialization failed`。因此 sandbox 仅**生产构建**保持 `true`，dev 期以 `process.env.NODE_ENV_ELECTRON_VITE === 'development'` 判定临时关闭（`isDev`）。`build/entitlements.mac.plist` 已配（最小权限：`allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`，**不开 app-sandbox**——需自由读写用户选定的工作区），正式打包安全姿态不变。

**窗口生命周期（`src/main/index.ts`）**：

- 关闭拦截：`mainWindow.on('close')` 默认 `preventDefault`，经 `app:requestClose` 询问渲染层；渲染层决策后 `app:confirmClose` 置位 `allowClose` 并 `mainWindow.destroy()`（绕过 close 事件，防递归卡死）。每个新窗口创建时复位 `allowClose=false`。
- `window-all-closed` → `app.quit()`：产品决策"关窗 = 退出整个应用"，不走 macOS"关窗留 Dock"惯例（用户明确要求关窗后服务进程结束，含 dev 期 electron-vite 进程链）。

### 2.2 目录结构（对照实际文件）

```
project-root/
├── src/
│   ├── shared/                  # main/preload/renderer 共享类型与契约（唯一真源）
│   │   └── types/fs.ts          # FsResult / FsError / FileNode / FileProbe / FsChangeEvent / Eol / DropOpenResult
│   │   └── types/git.ts         # GitStatusSnapshot / GitStatusCode / GitStatusEntry
│   ├── main/                    # 主进程
│   │   ├── index.ts             # 应用入口：创建窗口 + close 拦截 + clipboard + 事件推送
│   │   ├── services/
│   │   │   ├── FileSystemService.ts   # 全部磁盘操作（读/写/树/重命名/移动/dropOpen/监听）
│   │   │   └── GitStatusService.ts    # git 状态采集（§10.4）
│   │   └── ipc/
│   │       ├── fsHandlers.ts    # fs:* / dialog:* ipcMain.handle 注册（toClientError 剥 path）
│   │       └── gitHandlers.ts   # git:status ipcMain.handle 注册（裸快照，无信封）
│   ├── preload/index.ts         # contextBridge 桥接（fileAPI 白名单，19 个成员，§3.6）
│   └── renderer/                # 渲染进程（React）
│       ├── main.tsx             # 渲染入口（顶部 import './monacoSetup' 离线化，必须先于 App）
│       ├── App.tsx              # 顶层容器：状态编排 + 事件订阅 + 刷新调度 + 保存链路
│       ├── components/          # FileTree / CodeEditor / FilePreviewGate / ImageViewer / UnsupportedViewer / 4 个模态框
│       ├── hooks/useFileAPI.ts  # fileAPI 调用封装（FsResult 信封解包 + TransportError）
│       ├── modelRegistry.ts     # Monaco model 注册表（tab 与编辑器状态映射，§7.2）
│       ├── monacoSetup.ts       # Monaco 离线化（本地 loader + 5 种 worker）
│       ├── settings.ts          # localStorage 设置（自动保存 / 分栏宽度，§10.3/§10.2）
│       ├── styles.ts            # 内联样式集合（全部 UI 样式单文件）
│       ├── utils/lang.ts        # 扩展名 → Monaco language id（detectLanguage）
│       ├── electron.d.ts        # window.fileAPI 类型声明
│       └── vite-env.d.ts        # vite/client 类型引用
├── scripts/
│   ├── dev-daemon.mjs           # start/stop/status/run 守护（§11.2）
│   ├── dist.mjs                 # 打包封装（§12.2）
│   ├── verify-artifacts.mjs     # 产物校验 + SHA256SUMS（见 ci-release-pipeline.md）
│   ├── clean.mjs                # clean / clean deep
│   └── e2e/                     # CDP 端到端测试（run / cdp-client / app-helpers / util / README，§11.4）
├── .github/workflows/           # 5 个 workflow（ci / release-desktop / build-mac / build-windows / build-linux）
├── electron-builder.yml         # 三端打包配置
├── electron.vite.config.ts      # main/preload/renderer 三处 @shared alias
├── pnpm-workspace.yaml          # pnpm 11 allowBuilds（electron:true / esbuild:true / electron-winstaller:false）
├── .gitignore                   # node_modules/out/dist/log/pid/.workbuddy 等（见 §11.2 运行产物）
└── docs/
    ├── electron-file-editor-design.md   # 本文
    ├── ci-release-pipeline.md           # 发布/签名链路
    └── archive/                         # 已删除：仅作重写防中断临时备份，完成后清理（历史以 git 为准）
```

结构意义：`main` / `preload` / `renderer` 三目录物理隔离，未来转插件时 renderer 的 UI 改动最小，只需把 `FileSystemService` 能力换成宿主 IDE 的插件 API。

### 2.3 数据流总览

三条主线贯穿全文档：

| 主线 | 链路 | 章节 |
|---|---|---|
| 读 | 点击文件 → `probeFile` 预检 → 文本/图片/不支持 分流 → Monaco / ImageViewer / 提示页 | §6 |
| 写 | 编辑 → `writeFile`（渲染层一律 force 覆盖写盘）→ 落盘 → self 事件 → 树刷新 | §7.3、§5.5 |
| 事件 | chokidar → 主进程合成 `FsChangeEvent`（self/external、renamed）→ `fs:changed` → 渲染层去抖合并刷新 / 冲突 UI | §5.4、§8、§9 |

---

## 3. 共享契约（类型真源）

> **类型落点（重要）**：以下契约类型全部定义于 `src/shared/types/fs.ts` 与 `src/shared/types/git.ts`，经 tsconfig `paths` 别名 `@shared` 被三方引用。**不要放进 main/ 或 renderer/ 下**——main 下文件渲染层无法 import，会破坏三目录物理隔离，也让转插件时共享契约复用失去意义。本节是语义定稿，字段以代码文件为准。

### 3.1 错误契约（`FsResult` / `FsError`）

所有 `ipcMain.handle` 的读写类方法**不抛领域错误**，统一返回结果信封，便于前端按 `code` 分支：

```typescript
export type FsErrorCode =
  | 'E_NOENT'       // 路径不存在
  | 'E_PERM'        // 权限不足（含 Mac 沙盒未授权 / 未设定工作区根）
  | 'E_EXIST'       // 创建时路径已存在 / rename 目标已存在
  | 'E_ISDIR'       // 期望文件但遇到目录
  | 'E_NOTDIR'      // 期望目录但遇到文件 / 根候选不是目录
  | 'E_TOOBIG'      // 文件超过阈值（文本 50MB / 图片 20MB，§6.1/§6.5）
  | 'E_ESCAPE'      // 路径穿越工作区根（§4.2）
  | 'E_UNSUPPORTED' // 二进制 / 不支持预览的类型 / 非图片文件（§6）
  | 'E_CONFLICT'    // 主进程 API 层防御：非 force 保存时发现外部改动（§7.3；渲染层保存恒走 force，不触发）
  | 'E_INVALID'     // 非法操作参数（如把目录移入自身/自身子目录，§5.2 renameEntry 自子树守卫）
  | 'E_UNKNOWN';

export type FsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FsError };
```

**信息泄露防护（P0）**：`FsError.path` 仅用于主进程本地日志，**绝不序列化到渲染层**——`ipcMain.handle` 的返回值会被结构化克隆完整发往渲染进程，`E_ESCAPE`/`E_NOENT` 的 path 原样发送会把真实绝对路径泄露给渲染层。所有 handler 返回前统一调 `toClientError(error)` 剥除 `path`，只留 `code` 与 message（实现见 `src/main/ipc/fsHandlers.ts` 的 `wrap()`）。渲染层永远拿不到真实路径。

**两类失败必须区分**：`ipcRenderer.invoke` 在进程崩溃/网络层异常时仍会 reject（transport error，渲染层 `useFileAPI` 包装为 `TransportError`，UI 提示"主进程通信失败"）；`ok:false` 是主进程明确拒绝（按 code 分支）。二者 UI 提示不同。

**信封外的例外通道**（不经 `FsResult`、不经 `toClientError`）：

| 通道 | 返回 | 说明 |
|---|---|---|
| `dialog:openDirectory` | `Promise<string \| null>` | 取消返回 null；不做 containment（此时尚无 root，见 §4.2） |
| `clipboard:writeText` | `Promise<void>` | 无失败语义 |
| `git:status` | `Promise<GitStatusSnapshot>`（裸快照） | git 状态不含真实文件内容，无 path 泄露风险，故不剥 path、不经信封（§3.5、§10.4） |
| `app:confirmClose` | 无（`ipcRenderer.send`） | 单向通知 |

### 3.2 目录节点（`FileNode` 状态机）

```typescript
export type NodeLoadState = 'unloaded' | 'loading' | 'loaded' | 'empty' | 'error';

export interface FileNode {
  name: string;
  path: string;                 // 绝对路径（节点唯一标识）
  type: 'file' | 'directory';
  children?: FileNode[];
  loadState?: NodeLoadState;    // 仅 directory：子节点加载状态（与 UI expanded 解耦）
  loadError?: string;           // loadState==='error' 时的可读信息
  expanded?: boolean;           // UI 状态：是否已展开（只决定是否触发懒加载）
}
```

状态迁移：`unloaded --(展开)--> loading --(成功有子)--> loaded`；`loading --(成功无子)--> empty`；`loading --(失败)--> error`（error 提供"重试"语义——再次点击走 loading）。`readDirectory` 返回的节点初始 `loadState:'unloaded'`（目录）或 `undefined`（文件）、`expanded:false`（代码见 `FileSystemService.readDirectory`）。

### 3.3 文件变化事件（`FsChangeEvent`）

主进程经 `fs:changed` 推送、前端 `onFileChanged` 订阅消费：

```typescript
export type FsChangeType = 'created' | 'modified' | 'deleted' | 'renamed';
export type FsChangeSource = 'self' | 'external';   // self=本应用写操作；external=git/其他程序

export interface FsChangeEvent {
  type: FsChangeType;
  path: string;          // 受影响条目的当前路径
  oldPath?: string;      // 仅 type==='renamed' 时携带
  kind: 'file' | 'directory';
  source: FsChangeSource;
  seq: number;           // 主进程单调递增序号（pushEvent 统一分配，前端去抖与排序用）
  at: number;            // 事件发生时间（ms epoch）
}
```

实现细节：chokidar 回调里 `emit()` 以 `seq:0` 构造事件，`pushEvent()` 统一补 `seq: ++this.seq` 与 `at: Date.now()` 再推送（`FileSystemService.ts`）。

### 3.4 文件预检（`FileProbe` / `Eol`）

```typescript
export type FileCategory = 'text' | 'binary' | 'large';

export interface FileProbe {
  size: number;
  category: FileCategory;   // 'text' | 'binary' | 'large'
  encoding?: string;        // 仅 text：检测到的编码（默认 'utf-8'）
  mimeType?: string;        // 仅 binary：magic bytes 识别（如 'image/png'）
  previewable: boolean;     // 是否允许在 Monaco 中打开
}

export type Eol = 'LF' | 'CRLF' | 'Mixed';
```

> **probe 的返回语义（以代码为准）**：`probeFile` 对 `large` / `binary` **返回 `ok:true` 携带 category 标记**（不是错误），把"判定"与"拒绝"分开——`readFile` 才把它们转成 `E_TOOBIG` / `E_UNSUPPORTED`。`FilePreviewGate` 也据此分流（§6.6）。不要写成"probe 直接返回错误"。

### 3.5 Git 状态（`GitStatusSnapshot`）

```typescript
// shared/types/git.ts
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'C' | 'R';
export interface GitStatusEntry { path: string; code: GitStatusCode }  // path 为绝对路径（已按 workspaceRoot 重定位）
export interface GitStatusSnapshot { enabled: boolean; entries: GitStatusEntry[]; at: number }
```

**实际契约（重要）**：`fileAPI.readGitStatus(workspaceRoot: string)` 返回**裸 `GitStatusSnapshot`**——`git:status` handler 直接 `service.getStatus(workspaceRoot)`，**不经 `FsResult` 信封、不经 `toClientError`**（git 状态不含真实文件内容，无 path 泄露风险）。非仓库 / 无 git / 超时降级时返回 `{ enabled:false }`（不是错误），渲染层据此跳过装饰。语义见 §10.4。

### 3.6 preload 白名单（`fileAPI` 全集）

`preload.js` 是渲染进程唯一能看到主进程能力的窗口，必须白名单暴露，**禁止暴露整个 `ipcRenderer`**。完整实现见 `src/preload/index.ts`（19 个成员），契约签名（`electron.d.ts` 同步声明）：

```typescript
window.fileAPI = {
  // —— 读 ——
  readDirectory: (path) => Promise<FsResult<FileNode[]>>,      // 懒加载单层
  readFile: (path) => Promise<FsResult<{ content; encoding; eol }>>,
  probeFile: (path) => Promise<FsResult<FileProbe>>,
  readImage: (path) => Promise<FsResult<{ dataUrl }>>,          // 图片预览（§6.5）
  // —— 写 ——
  writeFile: (path, content, opts?: { force }) => Promise<FsResult<void>>,
  createFile: (path) => Promise<FsResult<void>>,               // 嵌套路径自动建父目录
  createDirectory: (path) => Promise<FsResult<void>>,
  deleteEntry: (path) => Promise<FsResult<void>>,
  renameEntry: (oldPath, newPath) => Promise<FsResult<void>>,
  // —— 目录监听（watchId 契约，§5.3）——
  watchDir: (path) => Promise<FsResult<{ watchId }>>,
  unwatchDir: (watchId) => Promise<FsResult<void>>,
  // —— 拖拽打开（§10.6）——
  getPathForFile: (file: File) => string,                      // webUtils.getPathForFile（Electron 44 替代 File.path）
  dropOpen: (paths: string[]) => Promise<FsResult<DropOpenResult>>,
  // —— 系统能力 ——
  openDirectoryDialog: () => Promise<string | null>,           // 无信封（取消 → null）
  copyText: (text) => Promise<void>,                           // 剪贴板（沙箱下 navigator.clipboard 不可靠）
  readGitStatus: (workspaceRoot: string) => Promise<GitStatusSnapshot>,  // 裸快照，无信封（§3.5）
  // —— 事件订阅（返回退订函数，卸载时必须调用防监听器累积）——
  onFileChanged: (cb: (e: FsChangeEvent) => void) => () => void,
  // —— 关闭客户端拦截（§7.4）——
  onRequestClose: (cb: () => void) => () => void,              // 主进程 close 时询问
  confirmClose: () => void,                                    // 渲染层决策后放行真正关闭
};
```

> **剪贴板机制（为何不经 `navigator.clipboard`）**：`sandbox:true` + `contextIsolation:true` 下渲染层是网页环境，`navigator.clipboard.writeText` 仅在安全上下文（https/localhost）可用，生产以 `file://` 加载不可靠。统一经 `fileAPI.copyText` → IPC → 主进程 `clipboard.writeText`，与其他能力一致走沙箱安全路径。

**`DropOpenResult` 类型**（`shared/types/fs.ts`）：

```typescript
export interface DropOpenResult {
  root: string | null;   // 本次拖入产生的新工作区根（拖入目录 / 文件自动提升父目录）；null=沿用当前根
  files: string[];       // 应在当前根内直接打开的文件（主进程已按 containment 过滤）
}
```

**`useFileAPI` 封装**（`src/renderer/hooks/useFileAPI.ts`）：所有 `FsResult` 方法统一经 `invoke()` 解包——成功返回 `data`，领域错误抛出 `FsError`，IPC reject 抛 `TransportError`（UI 提示"主进程通信失败"）。整个 api 对象经 `useMemo`（空依赖）稳定化，**必须稳定**——否则 `FilePreviewGate`/`CodeEditor` 的 effect 依赖含 `api`，引用变化会导致 effect 每次渲染重跑、读盘响应被 latest-guard 丢弃（曾实测触发状态栏永久"读取中…"）。

---

## 4. 安全模型（P0）

### 4.1 威胁模型

`FileSystemService.readFile(filePath)` 若直接信任渲染进程传来的任意路径：虽然 `contextIsolation` 挡住渲染进程直接拿 Node，但 `fileAPI` 是主进程**唯一暴露的攻击面**——一旦渲染进程因预览含恶意脚本的 Markdown/HTML 触发 XSS，攻击者可调 `fileAPI.readFile('/etc/passwd')` 或用 `../../` 穿越读取工作区外任意文件。这是文件类应用最基础也最易漏掉的一道校验。

防线层次：`contextIsolation` / `nodeIntegration:false` / `sandbox` 是**第一道**（阻止渲染进程直接拿 Node）；本节 containment 是**第二道**（约束已暴露的 fileAPI 能力边界）。二者互补、缺一不可。

### 4.2 工作区根 containment（`assertWithinRoot` / `validateRootCandidate` / `resolveExistingAncestor`）

- 服务构造时 `workspaceRoot` 为 null；**根目录只能由主进程设定**——经 `openDirectoryDialog`（对话框）或 `openDirectoryAt`（显式路径，dropOpen 复用），两者都先走 `validateRootCandidate` 准入。渲染进程无权指定根。
- 所有接受路径的方法（`readFile`/`writeFile`/`probeFile`/`createFile`/`createDirectory`/`deleteEntry`/`renameEntry`/`readDirectory`/`watchDir`/`readImage`）执行前统一调 `assertWithinRoot`。
- **`renameEntry(oldPath, newPath)` 两个路径参数都要校验**——只校验 oldPath、漏掉 newPath 等于开半个穿越口子（攻击者可借 rename 把文件移到工作区外）。
- **必须 `fs.realpath` 解析符号链接后再校验**，否则工作区内 symlink 指向外部目录可绕过 `path.resolve`（后者不跟 symlink）：

```typescript
private async assertWithinRoot(target: string): Promise<void> {
  const root = this.workspaceRoot;
  if (!root) throw this.err('E_PERM', 'no workspace root set'); // 未设定根 → E_PERM
  const resolvedRoot = await fs.realpath(root);
  const candidate = path.resolve(root, target);

  let real: string;
  try {
    real = await fs.realpath(candidate);          // 目标已存在：realpath 展开 symlink
  } catch {
    // 目标不存在（create/rename 新路径）：校验父目录，再拼回文件名
    real = await this.resolveExistingAncestor(candidate);
  }

  const rel = path.relative(resolvedRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw this.err('E_ESCAPE', 'path escapes workspace root', target); // message 不含 target 真实路径
  }
}

// 递归向上找最近存在的祖先目录，再拼回候选路径的文件名（§4.2 P0 边界）
private async resolveExistingAncestor(candidate: string): Promise<string> {
  let dir = path.dirname(candidate);
  for (;;) {
    try {
      const realDir = await fs.realpath(dir);
      return path.join(realDir, path.basename(candidate));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return candidate; // 已到文件系统根仍不存在，交由 containment 拒绝
      dir = parent;
    }
  }
}
```

> **P0 边界（多级嵌套创建）**：`createDirectory('a/b/c')` 时父目录 `a/b` 也可能不存在，`path.dirname` 的 realpath 同样抛 `ENOENT`。`resolveExistingAncestor` 递归向上找最近存在的祖先做 containment，再反向拼回。契约上保证：无论目标存不存在，最终用于校验的 `real` 都落在 `workspaceRoot` 之内，否则一律 `E_ESCAPE`。

**设定根时的准入检查 ≠ containment**：`validateRootCandidate(p)` 做 `fs.stat`（必须是目录）+ `fs.readdir`（探读权限），通过后才设为 workspaceRoot——此时还不存在"已有根"可供校验，不能调 `assertWithinRoot`。这是"设定根之前的准入检查"，与"根设定之后对操作路径的 containment"是两回事。

### 4.3 路径比较归一化（`normalizePathForCompare`）

`assertWithinRoot` 用 realpath 得到规范路径再 `relative`，已规避大多数大小写/符号链接问题。但有两处额外归一化需求——与安全无直接关系，却会导致逻辑错误：

- **Windows 大小写不敏感 + 盘符**：`C:\A` 与 `c:\a` 同一路径。比较前 `path.normalize(p).toLowerCase()`（仅 Windows 生效）。
- **macOS NFD/NFC（中文高频坑）**：macOS 文件系统默认以 NFD 分解形式存文件名，用户态常输入 NFC 合成形式，同一文件名在字符串比较时不相等 → 树节点匹配失败、rename 配对漏配。比较前 `String.normalize('NFC')`（老 Node 不支持时 try/catch 忽略）。

**用途与禁忌**：`normalizePathForCompare` 仅用于 ① 树节点 path 与事件 path 匹配（§8 配对、局部刷新）；② selfWriteTracker 与 readSnapshot 的 Map key；③ 外部 rename 配对缓冲 key；④ dropOpen 的 `isInside` 前缀过滤。**绝不用归一化后的路径执行 fs 操作**（可能改变实际大小写导致打开失败）——归一化只用于"比较"，不用于"寻址"。

### 4.4 校验失败的用户侧表现

`E_ESCAPE` 前端统一提示"无权访问该路径"（渲染层把 `FsError.message` 展示在状态栏，message 本身不含真实路径，与 §3.1 的 toClientError 一致）。`E_PERM`（未设定根）在正常流程中不会出现（根一定先于操作设定）。

---

## 5. 文件系统服务（`FileSystemService`）

所有磁盘操作集中在 `src/main/services/FileSystemService.ts`（661 行），前端永远不直接碰 fs。接口签名见 §3.6 的 fileAPI（服务是它的实现），本节讲关键设计决策与实际实现。

### 5.1 懒加载目录树

**不要一次性递归读取整个工作区**（大型项目几万个文件会卡死主进程）。只读当前展开层级，点击展开时再请求子层：

- `readDirectory` 只返回一层：`fs.readdir(dirPath, { withFileTypes: true })`，**过滤所有层级的 `.` 开头隐藏条目**（`!entry.name.startsWith('.')`，MVP 简化），排序**目录优先、同类型按 `localeCompare`**。
- 节点构造：`{ name, path: path.join(dir, name), type, loadState: isDirectory ? 'unloaded' : undefined, expanded: false }`。
- 路径统一用 Node `path` 模块处理，**永远不手写字符串拼接**（三端分隔符不同）；渲染层无 `node:path`，用轻量 `joinPath`（posix 拼接，App.tsx）。

### 5.2 写操作（嵌套创建 / rename 双路径 / 自子树守卫）

对照代码的精确行为：

| 操作 | 校验顺序 | 成功副作用 |
|---|---|---|
| `createFile` | containment → `exists` 已存在 `E_EXIST` → `mkdir(parentDir, {recursive:true})` → `writeFile(path, '')` | `markSelf([path])` |
| `createDirectory` | containment → `mkdir(path, {recursive:true})`（**幂等，无 E_EXIST 检查**——重复创建不报错） | `markSelf([path])` |
| `deleteEntry` | containment → `fs.rm(path, {recursive:true, force:false})` | `markSelf([path])` + `readSnapshot.delete(normPath)` |
| `renameEntry` | 双路径 containment → 源 `exists` 否则 `E_NOENT` → **自子树守卫** → 目标 `exists` 则 `E_EXIST` → `fs.rename` | `markSelf([old,new])` + 迁移快照 key |

**`renameEntry` 自子树守卫（代码确认，先于 E_EXIST）**：

```typescript
if (newPath === oldPath || newPath.startsWith(oldPath + '/')) {
  return { ok: false, error: this.err('E_INVALID', 'cannot move a directory into itself') };
}
```

放在 `E_EXIST` 之前的原因：自子树场景下目标往往是**已存在的后代目录**（如 `deep → deep/x`），报"不能移进自己"比"目标已存在"准确得多；纯重命名/普通移动的新路径必不存在，该检查对它们无影响。`fs.rename` 自身也会拒绝（EINVAL），这里显式拦截以返回可读错误（`E_INVALID`）。

**快照迁移**：rename 成功后把 `readSnapshot[oldPath]` 迁移到 `readSnapshot[newPath]`（§7.3，否则改名后首次保存因快照缺失跳过校验或误命中旧路径）；`deleteEntry` 同步删除对应快照 key。

### 5.3 目录监听：watchId 契约

**函数无法跨 IPC 传递**——主进程内部 `watchDirectory(dirPath, onChange): () => void` 的取消函数无法序列化给渲染层。因此暴露给渲染层的是 **watchId 契约**：`watchDir(dirPath)` 返回 `{ watchId }`（`w_${++watchSeq}`），`unwatchDir(watchId)` 退订；事件统一经 `fs:changed` 推送、由 `onFileChanged` 订阅消费。主进程内部维护 `watchers: Map<watchId, dispose函数>`。

### 5.4 监听面同步（懒加载的必然推论）

1. **监听以目录为单位，子项变化经 `fs:changed` 推送单层事件**（不递归广播整棵子树），前端只对 `loadState==='loaded'` 的父节点局部刷新。**根层边界**：tree state 存的是「根目录的 children 数组」，root 本身不是树内节点——事件父目录 / 写操作 parent 解析到 `workspaceRoot` 时，局部刷新（`updateNode` 按路径找节点）会静默无操作（曾导致根层删除/重命名/外部改动后界面不刷新，而磁盘已变更）。约定：刷新目标 === `workspaceRoot` 时**退化为整树重载**，且整树重载必须**先收集已展开路径、重载后恢复展开态并逐级补载子节点**（DFS 先序，父先于子；已有 watch 不动），避免根层一次变动把会话内展开状态全部塌掉。
2. **监听范围必须与懒加载展开状态同步**（否则懒加载失去意义）：只监听已展开（`loadState==='loaded'`）的目录，`depth: 0`（不递归）；子目录展开时 `watchDir` 追加监听，收起时 `unwatchDir` 移除。**目录被删除时同样回收**：事件订阅里对 `kind==='directory' && type==='deleted'` 的事件（self/external 一致）遍历 watchMap 退订该目录及其子树全部 watchId（`dir === e.path || dir.startsWith(e.path + '/')`），整树重载的恢复循环遇到已消失目录也顺带回收——否则 chokidar watcher 随删除操作持续泄漏。监听面始终 = 当前可见子树。

### 5.5 自写识别器（`selfWriteTracker`，事件源判定）

§8 的冲突矩阵完全依赖 `FsChangeEvent.source`，但 chokidar 对本应用的自写操作同样会触发 `fs:changed`；若不区分，source 不可靠、冲突矩阵落空。同时 **chokidar 不发 `renamed`**，只发 `unlink` + `add`，`oldPath` 必须由主进程合成。两件事都在主进程解决：

- `writeFile`/`createFile`/`createDirectory`/`deleteEntry`/`renameEntry` 执行**成功后**，把受影响路径记入 `selfWriteTracker: Map<归一化路径, timestamp>`，短期 TTL（`SELF_WRITE_TTL = 1000ms`）。
- 收到 chokidar 事件时（`emit()`），若路径在 Map 内且 `now - ts < TTL` → `source: 'self'`；否则 `'external'`（超时条目顺手删除）。
- **TTL 必须 ≥ 底层事件通道延迟上限**：macOS FSEvents 系统繁忙时延迟可超 500ms，TTL 过小会把自写事件误判 external、弹假冲突。验收点：**自己保存绝不弹冲突提示**。
- Map key 经 `normalizePathForCompare` 归一化（§4.3）；`renameEntry` 的 oldPath 与 newPath 都要登记。

**外部 `renamed` 合成**：维护"近期被删"缓冲 `deleteBuffer: Map<dir\|name, {name, at}>`（`RENAME_PAIR_TTL = 200ms`）——收到 `unlink`（`handleUnlink`）记入缓冲并 emit `deleted`；收到同目录 `add`（`handleAdd`）时查缓冲，时间窗内、同目录的待配记录 → 合成 `type:'renamed'`（path=新路径、oldPath=被删路径），否则按普通 `created`。本应用 `renameEntry` 已走 selfWriteTracker（标 self），不进入外部配对。

### 5.6 忽略规则与监听参数（chokidar 4 实况）

`watchDirectory` 实际参数（`FileSystemService.ts` L601-607）：

```typescript
chokidar.watch(dirPath, {
  depth: 0,              // 只监听本目录单层（§5.4）
  ignoreInitial: true,
  // chokidar 4 起移除 useFsEvents：macOS 上始终使用 FSEvents（§5.3）
  ignored: /(^|[/\\])(node_modules|\.git)([/\\]|$)/, // §5.6（字符类内无需转义 /）
});
```

> **⚠️ 与旧文档的差异（代码为准）**：chokidar 4 已**移除 `useFsEvents` 选项**（该选项属于 chokidar 3），macOS 恒用 FSEvents。不要在生产代码里再传 `useFsEvents: true`（会被忽略，属无效配置）。监听事件：`add` / `change` / `unlink` / `addDir` / `unlinkDir`（无 `rename` 事件，renamed 由 unlink+add 合成，§5.5）。

叠加 §5.4 的"只监听已展开目录且 depth:0"，忽略 `node_modules` / `.git` 防止密集事件拖垮主进程。

---

## 6. 文件内容管线（预检 → 分流 → 解码/预览）

统一在 `readFile` **之前**插入 `probeFile` 预检环节，解决三类问题：超大文件卡死、二进制被当字符串解析出乱码、非 UTF-8 乱码。编码策略定稿为**工作区文本统一 UTF-8 无 BOM**（不做多编码猜测）。

### 6.1 `probeFile` 预检流程（顺序不可调换：containment 永远是第一步）

- **0. containment 优先**：进入本流程前必须先过 `assertWithinRoot`（§4.2）。`probeFile`/`readFile` 内部也会各自再调一次（纵深防御）。**绝不允许在未经校验的路径上先开文件读字节**——那正是 §4.1 要堵的攻击面。E_ESCAPE 时整条链路终止。
- **1. 取大小**：`stat.size > maxFileSize`（默认 50MB，`DEFAULT_MAX_FILE_SIZE`）→ `{ category:'large', previewable:false }`（**ok:true 信封**，见 §3.4 注）。UI 提示"文件过大"。
- **2. 编码判定优先于二进制（修正 UTF-16 误判，P0）**：读文件头 8KB 判断——**绝不能"含 NUL 即二进制"**，否则 UTF-16 文本（`61 00 62 00`）会被整类误判：
  1. **BOM 探测优先**（`detectBom`）：`EF BB BF`→utf-8、`FF FE`→utf-16le、`FE FF`→utf-16be。命中 BOM 即判 text 并写入 encoding（UTF-16 合法字节本就含 00，正因如此必须先查 BOM）。
  2. 无 BOM 时**一律按 UTF-8 处理**（不做多编码猜测）：扫样本是否含 NUL——含 NUL → binary（`detectMime` 识别 mimeType）；否则 text、`encoding:'utf-8'`。
  3. 确定为 binary 后用 magic bytes 识别 `mimeType`（`detectMime`）：jpeg `FF D8` / png `89 50` / gif `47 49` / webp `RIFF`+`WEBP`（避免与 RIFF 音频误判）/ BMP `BM` / ICO `00 00 01 00`；未知 → `application/octet-stream`。
- **3. 编码约定（用户验收要求）**：工作区文本统一 **UTF-8 无 BOM**（Linux 平台工具链兼容）。BOM 只用于识别并正确解码，读取结果一律剥 BOM 字符；**写入恒为 UTF-8 无 BOM**（`writeFile` 直接 `fs.writeFile(..., 'utf-8')`）。不提供编码猜测/手动切换。
- **4. 返回**：`{size, category, encoding?, mimeType?, previewable}`（**large/binary 也是 ok:true**）；`readFile` 层才把 `large`→`E_TOOBIG`、`binary`→`E_UNSUPPORTED`。

### 6.2 `readFile` 链路

严格按 **containment（§4.2）→ 预检（§6.1）→ 读取** 顺序：先 `assertWithinRoot`（即便调用方已校验，这里再拦一次纵深防御），再 `probeFile`；`large` 返回 `E_TOOBIG`、`binary` 返回 `E_UNSUPPORTED`（透传 probe 错误如 E_ESCAPE/E_NOENT/E_ISDIR）；`text` 解码：

- `encoding==='utf-8'` → `raw.toString('utf-8')`；BOM 明确的 UTF-16 → `iconv-lite.decode(raw, encoding)`（失败兜底 utf-8）。
- 结果统一剥 BOM 字符（`content.replace(/^\uFEFF/, '')`，用转义避免源码内嵌不可见字符）。
- `detectEol(content)`：同时含 `\r\n` 与 `\n` → `Mixed`；仅 `\r\n` → `CRLF`；否则 `LF`。
- **成功后写 `readSnapshot`**（`{ mtimeMs, size }`，key 归一化）——§7.3 乐观并发防御的数据源。

### 6.3 换行符（EOL）数据链闭环

§1.3 承诺"写回保持原始换行符"，若 `readFile` 只返回 content+encoding，换行符信息在契约断链，保存时易被 Monaco 默认 `\n` 归一化破坏（git diff 全文件变更是高频坑）。闭环：

- `readFile` 返回 `eol`（§3.4）：主进程解码后统计换行符主导占比。
- **编辑器侧必须按 eol 设 Monaco model EOL**（`CodeEditor.tsx`）：`getOrCreateModel` → `model.setValue(content)` 后、**用户编辑之前**立即 `model.setEOL(eol==='CRLF' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF)`（Mixed 取 LF），否则 Monaco 按默认 EOL 立刻转换 content。
- **保存时直接写 `model.getValue()`**：model 已按选定 EOL 归一化，主进程原样落盘即可，**不得在 writeFile 侧再做换行符转换**。Mixed 场景用户编辑后 model 统一为单一 EOL，是可接受取舍。
- **加载期间不标 dirty**（`loadingRef` 守卫）：`setValue`/`setEOL` 触发的 `onDidChangeContent` 在加载态直接 return，避免"打开即脏"。

### 6.4 底部状态栏（编码 · 换行符展示 + 保存反馈）

- 主界面最底部常驻状态栏（左：当前文件/工作区路径；中：保存成功反馈；右：`编码 · 换行符`）。
- 数据源：`CodeEditor` 读盘成功后经 `onMeta({ encoding, eol })` 回调上报（readFile 返回值天然携带），App 持有 `activeMeta` 渲染。
- **meta 与 model 同生命周期**（`modelRegistry.ts` 的 `modelMeta` 表）：readFile 成功时 `setModelMeta`，关闭标签（`disposeModel`）时清除。CodeEditor 的 model 复用分支（tab 仍开、切回已有 model 时不读盘）从该表补报 meta（`getModelMeta`）——否则 openFile 清空 `activeMeta` 后无上报源，状态栏永远停在"读取中…"（空文件/重复点击/切 tab 高频触发，2026-08-30 已修复）。
- **openFile 同步恢复**：打开**已打开过**的文件时，openFile 直接从 meta 表同步恢复 `activeMeta`（不再清空等待）。因为重复点击同一文件时 `activePath` 值不变，React 对相同 state 值 bail out（不重渲染），FilePreviewGate/CodeEditor 均不重挂载、加载 effect 不重跑——若清空则无人补报（2026-08-30 实测复现）。仅首次打开（meta 表无记录）才清空，等 CodeEditor 读盘后经 onMeta 上报。
- 清空时机：首次打开文件（meta 表无记录时）、关闭活动标签、切换工作区；图片文件无 meta 概念，不显示"读取中…"占位。
- 显示约定：encoding 大写（`UTF-8`/`UTF-16LE`）、eol 原样（`LF`/`CRLF`/`Mixed`），如 `UTF-8 · LF`。
- 保存反馈（§7.3 改版 v2）：绿色短时反馈"保存成功"/"自动保存成功"，2.5s 自动消失（`saveFeedback` + nonce 重置计时）；手动保存（工具栏按钮 / Cmd+S）与自动保存分别提示，关闭时保存不提示。

### 6.5 图片预览数据链（`readImage`）

`readFile` 对 binary 恒返回 `E_UNSUPPORTED`——图片字节没有现成的出主进程通道，必须补独立契约：

- **链路**：渲染层点击文件 → 扩展名命中图片白名单（`App.tsx` 的 `isImage()`，正则 `\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i`）→ `readImage(filePath)` → 主进程 `assertWithinRoot` → 独立做**图片判定** → 读 buffer → base64 → 返回 `data:${mimeType};base64,...` → `<ImageViewer>` 以 `<img src={dataUrl}>` 自适应缩放展示。
- **判定不依赖 probeFile 的 category**（`detectImageMime`）：`detectMime` 结果以 `image/` 开头 → 直接采用；纯文本 SVG 会被 probe 判 text，按扩展名 `.svg` + 内容头复核（`<svg` / `<?xml`，剥 BOM + trimStart）→ `image/svg+xml`；都不中 → `E_UNSUPPORTED`（'not an image file'）。扩展名白名单与主进程判定不一致（如 `.txt` 伪装图片）时拒绝。
- **大小上限**：图片独立阈值 20MB（`IMAGE_MAX_SIZE`，小于文本 50MB——base64 有 ~33% 体积膨胀且需整体跨 IPC 传输），超限返回 `E_TOOBIG`。
- 类型检查：`stat.isFile()` 不满足（目录）→ `E_ISDIR`。
- **不支持的非图二进制**：返回 `E_UNSUPPORTED`，UI 显示页展示"暂不支持浏览" + 文件名/类型说明（`FilePreviewGate` 路由，见 §6.6），不提供任何读取通道。

### 6.6 预览范围（支持 / 不支持）

本应用定位"查看 + 编辑"，预览能力有明确边界。打开文件时 App 路由：`isImage()` 命中 → `ImageViewer`；否则进 `FilePreviewGate` 预检分流（§6.1）：

| 分流 | probe 结果 | 渲染 |
|---|---|---|
| `text` | `probe.category === 'text'` | Monaco 文本编辑器（`renderEditor(filePath)`） |
| `large` | `probe.category === 'large'` | `UnsupportedViewer`："文件过大，暂不支持浏览" |
| `binary` | `probe.category === 'binary'` | `UnsupportedViewer`："暂不支持浏览该文件类型" |
| `error` | probe 抛错（E_NOENT 等） | `UnsupportedViewer`："打开失败" + 错误信息 |

**实现细节**：`FilePreviewGate` 初始 state 即 `checking`（"检查文件…"），App 侧以 `key={activePath}` 重挂载来重置（切文件即新实例），**不在 effect 内同步 setState**——曾因 api 引用变化 → effect 重跑 → 同步 setState → 重渲染循环出现 `Maximum update depth exceeded`（React 冻结 UI，状态栏永久"读取中…"）。预检与 CodeEditor 内部的 readFile 会各 probe 一次，本地文件系统开销可忽略，换来路由准确性（避免二进制内容被塞进 Monaco）。

| 类别 | 格式（示例） | 渲染方式 |
|---|---|---|
| 文本 | `.txt` `.md` `.json` `.yaml` `.csv` `.log` 等 + 源码 `.js` `.ts` `.py` `.go` `.rs` 等无 NUL 的可解码文本（统一 UTF-8 无 BOM，§6.1） | Monaco（语法高亮 + 编辑） |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.bmp` `.ico`（magic bytes + 扩展名复核，§6.5） | `ImageViewer`（`<img>` 自适应缩放） |
| 不支持 | Office 文档（`.doc/.docx/.xls/.xlsx/.ppt/.pptx`）、PDF、其他专有二进制（`.zip/.exe/.dll/.so/.bin` 等） | `UnsupportedViewer`"暂不支持浏览"（无乱码、无红条） |

文本类以"能否被解码为可读字符串"为准，而非写死扩展名——任意可解码文本都能进 Monaco。大文件（>50MB）或超大图片（>20MB）走"过大"提示而非硬开。**边界说明**：当前不做 Office/PDF 解析渲染——这属"文档查看器"而非"文本编辑器"，超出产品定位。若未来支持，应在 §6 预检管线后新增独立预览通道（如 PDF.js），而非复用 Monaco。

---

## 7. 编辑与保存

### 7.1 Monaco 集成

- **离线化（已完成）**：`src/renderer/monacoSetup.ts` 改用本地 `monaco-editor`（`loader.config({ monaco })`）+ Vite `?worker` 配置 editor/json/css/html/ts 五种 worker（`MonacoEnvironment.getWorker` 按 label 分发：json/css|scss|less/html|handlebars|razor/typescript|javascript，兜底 editorWorker）。`main.tsx` 在 App 之前顶部 `import './monacoSetup'`。编辑器完全离线可用。
- **实例配置**：`monaco.editor.create(container, { automaticLayout: true, theme: 'vs' })`。
- **Cmd/Ctrl+S**：`ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())`（CtrlCmd 自动映射 Win/Linux Ctrl、Mac Cmd）。
- **language 映射**：`detectLanguage(filePath)` 扩展名 → Monaco language id（`utils/lang.ts` 的 `EXT_MAP`：ts/tsx→typescript、js/jsx/mjs/cjs→javascript、json/md/markdown/py/go/rs/java/kt/c/cpp/cc/h/hpp/html/htm/css/scss/less/sh/bash/zsh/yml/yaml/toml/ini/xml/sql/txt/log，兜底 `plaintext`）。
- **EOL 设置**：按 §6.3 在用户编辑前设 model EOL。
- **受控绑定陷阱**：用 `value` 受控绑定 Monaco 会与 model 撤销栈冲突。实际实现：**model 由 `modelRegistry` 持有生命周期**，切文件靠 `key={filePath}` 重挂载 + `editor.setModel(model)` 换 model 而非改 value（§7.2）。
- **latest-guard**：`filePath` 快速切换时 `readFile` 响应可能乱序，`reqId.current` 递增 + `cancelled` 标志，仅采纳最新一次请求的响应，丢弃过期响应，避免旧文件内容覆盖新标签。
- **回调经 ref 调用**：`onDirtyChange`/`onMeta`/`onSaved` 由 App 以箭头函数内联传入（每次渲染新建），不能进加载 effect 依赖数组——否则 App 任意重渲染都会使加载 effect 重跑（++reqId），正在进行的 readFile 响应被 latest-guard 丢弃，表现为状态栏永久"读取中…"。统一经 `onDirtyChangeRef`/`onMetaRef`/`onSavedRef` 调用。
- **撤销/重做句柄**：`useImperativeHandle` 暴露 `{ undo, redo }`，内部 `editor.trigger('keyboard', 'undo'|'redo', null)`，供工具栏按钮调用（§7.4 原语 3）。

### 7.2 多标签页管理

- **每个标签对应一个 Monaco Model**（`modelRegistry.ts`：`models: Map<filePath, ITextModel>`），uri 为 `file://<filePath>`；切换标签 `setModel` 复用（保留编辑历史与撤销栈），关闭标签 `disposeModel`（防内存泄漏）。
- **model 复用分支**：`CodeEditor` 加载 effect 里 `hasModel(filePath)` 且非 forceReload → 直接复用已有 model（保留未保存编辑），从 `modelMeta` 表补报 meta（§6.4），**不读磁盘、不重置 dirty**。
- `isDirty` 状态驱动标签页圆点提示（`t.isDirty ? ' •' : ''`），关闭前二次确认。
- **renamed 且文件正打开**（§8.3）：同步更新标签页 filePath 与 Model path（tab 路径迁移，精确匹配 + 前缀匹配，§10.5），不丢失编辑缓冲与 undo 栈。
- **批量关闭**（tab 栏右端常驻 `▾` 按钮 / tab 右键菜单）：
  - 菜单项：`关闭`（仅右键菜单）/ `关闭左侧全部` / `关闭右侧全部` / `关闭其他` / `关闭全部`。
  - 锚点语义：右键菜单以**被右键的 tab** 为锚；`▾` 按钮菜单以**活动 tab** 为锚（`anchor: null`）；最左/最右 tab 对应方向的菜单项置灰（disabled）。
  - 统一经 `closeRange(closedPaths)` 执行：`disposeModel`、从 openTabs 移除；若被关集合含活动 tab，则活动切到剩余最后一个并清空底部 meta（与单关 closeTab 行为一致）。
  - 去重保证：`openFile` 对已打开文件仅切换激活、不新增 tab（重复点击树节点不会重复开标签）。

### 7.3 保存链路（用户主动覆盖 + API 层乐观并发防御）

**产品语义（改版 v2）**：在浏览区编辑文档后保存（`Cmd/Ctrl+S`、工具栏"保存"、关闭时保存、自动定时保存），**保存文件即可**——一律以当前缓冲区覆盖写盘（`{ force: true }`），**不因外部改动而拒绝保存**。外部改动的可见性由 §8.2 的非阻塞提示条（双按钮）承担。理由：本产品是单用户、单工具编辑场景，用户主动按保存即表达"我要我的版本"，乐观并发拦截把正常保存误判为冲突，打断编辑流（曾因外部编辑器改过 mtime 导致本应用保存被 E_CONFLICT 拒绝，验收反馈为缺陷）。

- 渲染层所有保存入口（`CodeEditor.handleSave` / `App.saveActive` / `App.saveDirtyTabs`）一律传 `{ force: true }` 写盘。
- **保存成功反馈（改版 v2）**：底部状态栏短暂显示"保存成功"（工具栏保存按钮 / Cmd+S 经 CodeEditor `onSaved` 回调；注意 `saveActive` 与 `onSaved` 双入口都会触发，同一反馈无冲突）/ "自动保存成功"（自动定时保存，确有文件落盘才提示），2.5s 自动消失（`saveFeedback` state + nonce 重置计时）。关闭时保存不提示（即将关窗）。保存失败仍走工具栏 `status` 红字 / 编辑器底部红条。
- **外部修改提示条（§8.2，改版 v3）**：`[重新加载外部版本]` 丢弃未保存改动前先弹应用内 `ConfirmModal` 二次确认；`[保留当前版本]` 仅关闭提示不清 dirty。保存本身恒 force，两个按钮都不拦截、不改变任何保存入口的行为。
- 主进程保留 `readSnapshot: Map<path, { mtimeMs, size }>` 乐观并发机制（`readFile` 成功解码后写入；`writeFile` 在**非 force** 且 mtime/size 不一致时返回 `E_CONFLICT`），作为主进程 API 的防御能力留给未来非 UI 调用方；渲染层保存恒走 force，实际不会触发。
- 快照无该路径记录（绕过 readFile 直接保存）→ 跳过校验直接写。
- **writeFile 成功后立即用最新 stat 回写快照**，否则同一文件连续第二次保存会因快照仍是旧 mtime 而误报 E_CONFLICT。
- **rename 后迁移快照 key、delete 后删除快照 key**（§5.2）。

### 7.4 可靠编辑三件套（替代崩溃恢复，产品决策已定）

经权衡放弃"崩溃自动保存/恢复"——它把"查看+编辑"工具推向 IDE 式 hot-exit，复杂度高且与 §8 外部改动处理重叠/易双弹窗。改为三个更轻、更聚焦的原语：

1. **关闭客户端提示保存**：主进程 `win.on('close')` 拦截，`allowClose` 标志 + `app:requestClose` IPC 询问渲染层；有未保存文件弹三选框（`CloseConfirmModal`：保存/不保存/取消），取消则 abort 关闭。"保存"经 `saveDirtyTabs` 取各 dirty 标签最新内容（`modelRegistry.getModel`）force 写盘，"不保存"直接 `confirmClose` 放行（`allowClose=true; mainWindow.destroy()`）。实现：`src/main/index.ts`、`src/preload/index.ts`、`CloseConfirmModal`。
2. **自动定时保存（设置项，默认关）**：工具栏"设置"面板切换开关与间隔，经渲染层 localStorage 持久化（`src/renderer/settings.ts`，key `fileEditorSettings`，默认 `{autoSaveEnabled:false, autoSaveIntervalMs:30_000}`，间隔 ≥1000ms 校验）；启用时按间隔写回所有 dirty 标签并清 dirty（`saveDirtyTabs`，`setInterval(Math.max(1000, intervalMs))`）。
3. **会话内撤销/重做**：工具栏"回退/前进"按钮调 Monaco `editor.trigger('undo'/'redo')`（CodeEditor 改 forwardRef 暴露）；Monaco 维护 per-model 撤销栈，跨标签切换天然保留，Ctrl+Z / Ctrl+Y 原生快捷键仍可用。

**明确不做**：崩溃/断电后的内容恢复、关闭后重开上次标签（会话恢复）。

---

## 8. 文件变化事件与冲突处理

### 8.1 事件源判定（`self` vs `external`）

§3.3 的 `source` 由 §5.5 的 selfWriteTracker 判定。收到 `FsChangeEvent` 时，**仅 `source==='external'` 进入冲突流程**；`self` 只更新树元数据、不弹窗（避免自己保存触发自己的冲突提示）。

### 8.2 冲突判定矩阵（以 App.tsx 事件订阅实际逻辑为准）

| 文件是否打开在标签页 | 标签页 isDirty（有未保存改动） | 处理动作 |
|---|---|---|
| 否 | — | `scheduleRefreshNode(parentOf(path))` 局部刷新父目录（150ms 去抖，§9.2） |
| 是 | 否（已保存） | `reloadFile(path)` 自动重载（`reloadSignal` 触发 CodeEditor 强制重读）；顺带 `refreshGitStatus()` |
| 是 | 是（未保存） | `setActivePath(path)` 定位 + **非阻塞提示条 + 双按钮**（§7.3 改版 v3，不拦截保存）：`[重新加载外部版本]` `[保留当前版本]`。**重新加载** = 先弹应用内二次确认（`ConfirmModal`：`将丢弃 <path> 的未保存改动，确定重新加载外部版本？`，按钮文案 `确定重新加载`），确认后才 `reloadFile(path)` 加载外部最新内容——场景 B 的心智模型默认"我没动、外部动了"，直接重载会误吞正在写的编辑；**保留当前版本** = 仅关闭提示（`setExternalNote(null)`），不写盘、不清 dirty，文件再被外部修改会重新触发事件、提示重现。保存永不因外部改动被拒绝 |

**附加处理（代码确认）**：

- **目录被删除（self/external 一致）**：先遍历 watchMap 回收该目录及子树的全部 watchId（`dir === e.path || dir.startsWith(e.path + '/')`），防止 watcher 泄漏（§5.4 约束 2）。
- **任何事件处理后统一 `void refreshGitStatus()`**：git 装饰随任何文件变化刷新（主进程侧 2s 节流兜底，§10.4）。
- **dirty 清除联动**：`setDirty(path, false)`（保存成功/重新加载完成）时若 `externalNote === path` 自动清除提示——覆盖全部保存入口（Cmd+S / 保存按钮 / 关闭保存 / 自动保存）。

### 8.3 `renamed` / `deleted` 边界

- **renamed 且文件正打开**：`applyRename` 内同步更新标签页 filePath 与 Monaco Model（tab 路径迁移：精确匹配 + `oldPath + '/'` 前缀匹配，移动文件夹时其内已打开文件整体换路径），不丢失编辑缓冲与 undo 栈；旧路径 model `disposeModel`，active 走新路径并 `reloadSignal` 触发重读。
- **deleted 且文件正打开**：`doDelete` 内关闭相关标签（精确 + 前缀匹配），`disposeModel` 释放。外部删除（他人/git 删文件）当前实现为：事件到达 → 未打开文件局部刷新；已打开文件按 §8.2 矩阵处理（clean → 自动重载会失败显示打开失败；dirty → 提示条）。（v3 曾规划"文件已被外部删除"横幅，当前代码未实现该分支，以本节为准。）
- 删除后同目录新建同名文件：若 seq 相邻且 oldPath 匹配，优先识别为 renamed（§5.5）。

### 8.4 UI 文案可移植性

外部改动提示统一走渲染层组件（编辑区上方非阻塞提示条，复用 `styles.banner`，双按钮：重新加载外部版本 / 保留当前版本），不依赖任何 Electron 专有 API——符合 §1.2 原则 4，换宿主时无需重写。**改版 v3**：`[重新加载外部版本]` 在丢弃未保存改动前先弹应用内 `ConfirmModal` 二次确认（复用文件树删除确认同款组件，按钮文案 `确定重新加载`），防止场景 B 心智模型下误触丢编辑；确认/取消均不打断日常保存流程（保存恒 force，见 §7.3）。保存成功反馈走底部状态栏（§6.4 显示契约），同样为纯渲染层实现。

---

## 9. 性能设计

性能问题的根因链（曾实测）：文件事件风暴 → 并发整树重载 → IPC 风暴 + 全量重渲染。设计文档在此把防抖合并列为**强制约定**（不是建议），实现必须落地。

### 9.1 懒加载与监听面（结构性前提）

§5.1 懒加载 + §5.4 监听面同步，保证任何时刻的数据量与 IPC 量与"当前可见子树"成正比，与工作区总规模解耦。这是性能的第一道防线。

### 9.2 事件驱动刷新去抖（150ms）

- **事件回调一律走 `scheduleRefreshNode(dirPath)`（150ms 去重窗口），不直接刷新**：同一父目录在窗口内多次出现（rename 的 unlink+add 双事件、git checkout 的一批 modified）只刷最后一次（`refreshTimersRef: Map<dirPath|null, timer>`，key 为 null/`__root__` 时退化整树）。
- **操作后立即刷新**：新建/重命名/删除成功后的手动刷新走 `refreshNodeNow(dirPath)`（立即执行 + 取消该目录尚未执行的合并刷新）——操作结果需要确定性反馈，不能等去抖窗口。
- 同一 path 在防抖窗口内重复出现，取最后一次。

### 9.3 整树重载 in-flight 合并

`reloadTree` 并发调用共享同一个 in-flight Promise（`reloadInFlightRef`，已有重载在跑时直接复用）。根目录层事件 + 手动刷新可能并发触发多次整树重载，每次都重跑 N+1 次串行 readDirectory 并重建整树——合并后一次操作最多一次整树重载。模式同 GitStatusService 的节流（§10.4）。

### 9.4 根层退化与展开态恢复

刷新目标 === `workspaceRoot` 时退化为整树重载（§5.4 约束 1）；整树重载必须先收集已展开路径（`doReloadTree`：DFS 先序 = 父先于子）、重载后恢复展开态并逐级补载（`updateNode` 递归 patch，父先于子保证能在已载入的父层里找到子目录）；已建立的 watch 不动（watchMap 生命周期不受影响）；补载失败的目录（可能已被删除）顺带回收其 watch。卸载时清理 pending timers（`refreshTimersRef` 全清）。

### 9.5 chokidar 忽略规则

`ignored: /(^|[/\\])(node_modules|\.git)([/\\]|$)/` + `ignoreInitial: true` + `depth: 0`（§5.6）。**chokidar 4 无 `useFsEvents`**（macOS 恒 FSEvents）。监听粒度配合 §5.4：只监听已展开目录且 depth:0。

---

## 10. 渲染层交互

### 10.1 文件树（`FileTree`）

- **状态管理**：展开/选中状态放 React state，不与 Monaco 状态混在一起，经顶层容器 App 桥接（`toggleDir` / `openFile`）。
- **选中态必须可视化（实现硬要求）**：`selectedPath` 由 App 持有，文件点击与目录点击都要写入；FileTree 接收 prop 并高亮命中节点行（`rowSelected`）。没有选中高亮，用户无法感知"新建/重命名"作用于哪个节点——不是可选美化，是右键菜单语义的前提。
- **监听生命周期接线（实现硬要求）**：顶层容器维护 `watchMapRef: Map<dirPath, watchId>`：打开工作区后 watch 根；目录**展开时** `watchDir`、**收起时** `unwatchDir`；组件卸载或切换工作区遍历退订。收到 `onFileChanged` 按事件 path 的父目录**局部刷新**（只重读该层），不做整树 reloadTree（后者清空展开状态破坏浏览现场；根层事件除外，§9.4）。
- **右键上下文菜单（新建入口统一集中于此）**：所有节点（文件/目录）均含「新建文件」「新建文件夹」（目录新建于自身，文件新建于其**父目录**，菜单标注"新建于：<目标目录名>"）；所有节点含「重命名」「删除」「复制文件路径」（`copyText` 写入系统剪贴板，状态栏提示「已复制路径：<path>」）。**文件树空白区域右键同样弹菜单**（`node=null`，节点行 `stopPropagation` 不冲突）：仅含「新建文件」「新建文件夹」，目标为**工作区根**（提示"新建于：工作区根"），是空工作区/树外空白处的唯一新建入口——顶部工具栏不放新建按钮，新建一律走右键菜单，避免双入口歧义。
- **新建支持嵌套路径（实现硬要求）**：输入框允许填相对子目录路径（如 `src/utils/foo.ts`，placeholder 明确提示）。`createFile` 目标父目录缺失时自动递归创建（§5.2），创建成功后前端 `revealDirectory(targetParent)`（整树重载保底 + 从根到目标逐层展开），保证嵌套目录与新条目立即可见——只刷新一层会导致"新建了但树里看不到"。
- **⚠️ Electron 陷阱：渲染进程禁用原生 dialog（P0 实现注记）**：Chromium 在渲染进程中**默认禁用 `window.prompt`**（直接返回 null 静默 no-op，表现为"点了按钮没反应"），`confirm`/`alert` 可用但阻塞且样式不可控。因此「新建/重命名」文件名输入与「删除」「重新加载外部版本」二次确认，**必须用渲染层自建模态框**（`InputModal`/`ConfirmModal`：遮罩 + 输入框/文案 + 确认/取消），不得依赖任何 `window.*` 原生弹窗。这也满足 §1.2 原则 4 的可移植性要求。

### 10.2 视图布局（可拖拽分栏）

- 分隔条（`styles.splitter`，宽 5px，`cursor: col-resize`）位于 sidebar 与 editorArea 之间；`onMouseDown` 后在 document 挂 `mousemove`/`mouseup` 全局监听，实时更新 `sidebarWidth`（App 的 useState）。
- 宽度约束：最小 160px，编辑区至少留 260px（`Math.min(Math.max(clientX, 160), window.innerWidth - 260)`；settings.ts 常量 `SIDEBAR_MIN_WIDTH=160` / `SIDEBAR_DEFAULT_WIDTH=260` / `SIDEBAR_RIGHT_RESERVE=260`）。
- 视觉反馈：拖拽中分隔条变蓝（`splitterActive`）、`body` 临时 `cursor: col-resize`、`userSelect: none`。
- **宽度持久化（已完成）**：`mouseup` 时写入 localStorage（key `fileEditorSidebarWidth`，`saveSidebarWidth`）；启动时 `loadSidebarWidth()` 按当前窗口宽度重新钳制。读写失败静默降级默认 260px。

### 10.3 设置面板

工具栏"设置"切换：自动保存开关与间隔（§7.4 原语 2）。经 `src/renderer/settings.ts` 读写 localStorage（key `fileEditorSettings`），与分栏宽度（`fileEditorSidebarWidth`）**不共用 schema**。`SettingsModal` 间隔以秒输入（min 1s），保存时 `Math.max(1, floor || 1)` 秒转毫秒。

### 10.4 Git 状态高亮（可选增强，已完成）

工作区是 git 仓库时，文件树节点按 `git status` 着色 + 状态字母徽标。**纯增量装饰**，不改变文件树既有数据流，可整体降级（非 git 仓库/无 git 时静默关闭）。

- **数据来源**（`GitStatusService`）：`getStatus(workspaceRoot)`——先 `git rev-parse --show-toplevel`（cwd=workspaceRoot，超时 3s `TOPLEVEL_TIMEOUT_MS`）探测；失败 → `disabledForSession=true`（**本会话关闭**，不再重试）返回 `{enabled:false}`。采集 `git status --porcelain=v1 -uall --no-renames`（porcelain v1 稳定；`-uall` 展开未跟踪目录内文件与树上节点一一对应；`--no-renames` 把 rename 拆 D+A，避免解析 `old -> new` 双路径），解析为 `entries: {path: 绝对路径, code}`。
- **XY 码映射**（`mapCode`）：`??`→U（untracked）、`!!`→跳过（ignored）、`DD`/`AA`/`U*`/`*U`→C（unmerged/conflicted）、`D*`/`*D`→D、`M*`/`*M`→M、`A*`/`*A`→A、`R*`/`*R`→R、其余→null。**注意 `U` 由 `??` 归一化**（单字母展示）；`R` 在 `--no-renames` 下不出现，保留给未来。
- **执行方式**：`child_process.execFile('git', args, { cwd, timeout })`（不用 `shell:true` 防路径注入；cwd 固定 workspaceRoot）。禁止用 Node git 库实时解析——shell 出给系统 git 是最快且零依赖的方案。
- **刷新节奏（性能红线）**：`git status` 是大仓库重操作，**绝不挂在文件树渲染路径上**——触发源仅"打开工作区 + 任何 fs:changed 事件后"；主进程 ≥2s 最小间隔节流（`THROTTLE_MS=2000`，同 root 且窗口内直接返回缓存）+ in-flight 合并（并发请求共享同一个 Promise）；渲染层只在 `at` 变化时更新装饰（实际实现为每次刷新重算 `gitFileMap`/`gitDirMap`，setState 新 Map 触发重渲染）；**不轮询**。已知取舍：`.git` 被 chokidar ignore 排除，`git add`/`commit` 这类只动索引的操作不触发自动刷新，用户下次文件变更时状态自然追平。
- **git status 超时/失败降级**（`STATUS_TIMEOUT_MS=5000`）：沿用旧缓存 entries（`this.cache?.snap.entries ?? []`），`enabled:true`，不阻塞任何操作。
- **装饰规则**（对齐 VSCode；颜色为 `FileTree.tsx` 中 `GIT_COLORS` 常量表的**硬编码值**，经 inline style 应用——项目未引入 CSS 变量体系，全部 UI 样式收敛在 `styles.ts`，v5 核验修正 v4"颜色走 CSS 变量"的不准确表述）：`M` 黄 `#e2c08d` / `A` 绿 `#73c991` / `U` 绿 `#73c991` / `D` 红 `#f14c4c` / `C`（冲突）红 + 徽标 `!` / `R` 黄。**目录聚合**：目录本身无状态时，任意后代有状态则按最高优先级着色（`GIT_PRIORITY: C:5 > D:4 > M:3 > A:2 > U:1`，R 同 M 为 3），**不显示徽标**——折叠状态下也能感知子树内有未提交内容。
- **匹配粒度**：装饰 Map 由渲染层持有（key = 绝对路径，`App.refreshGitStatus` 从 entries 直接建 `gitFileMap`，`gitDirMap` 由 `parentDirOf` 逐级向上聚合）；`FileNode` 不内嵌 git 状态（保持 fs 契约纯净），`FileTree` 渲染时按 path 查表（目录取 `gitDirMap`、文件取 `gitFileMap`）。
- **边界**：工作区位于仓库子目录 → porcelain 以仓库根为基准，采集后按 `path.resolve(workspaceRoot, rest)` 相对 workspaceRoot 前缀过滤（`abs !== root && !abs.startsWith(root + sep)` 跳过），再重定位为绝对路径；嵌套仓库/submodule → 只识别最内层 toplevel（`rev-parse --show-toplevel` 天然返回最内层）；巨型仓库超时 → 沿用旧缓存，不阻塞任何操作。安全：execFile 参数数组固定、无用户输入拼接。

### 10.5 树内拖拽移动（`FileTree` + `App.applyRename`）

- 所有行 `draggable`，`dragstart` 时写入自定义 MIME `application/x-file-editor-path`（`TREE_DND_MIME`，`effectAllowed='move'`；setData 必须有值，否则 Chromium 不启动拖拽）；`dragend` 复位 App 拖拽状态。
- **仅目录行可作为落点**（`dragover` 合法目标 `preventDefault` + `dropEffect='move'` + 高亮 `rowDragOver`，非法目标 `dropEffect='none'` 不触发 drop）。**自子树守卫前置**（渲染层 `canDropInto`：`source !== target && !targetPath.startsWith(source + '/')`，主进程 `renameEntry` 再兜底 `E_INVALID`，§5.2）。
- **根落点**：树面板空白区域（非行元素，行用 `data-tree-row` 标记判定，`isTreeRow` = `closest('[data-tree-row]')`）即工作区根，与"空白右键新建于根"同语义——根层容器（depth=0）挂 `dragover/drop`，子层级空白冒泡到根容器统一判定；`dragleave` 用**鼠标坐标矩形**判断是否真正离开容器（HTML5 DnD 中 dragleave 的 relatedTarget 多为 null）。源已在根目录或源即根时前端 no-op（`handleMoveToRoot`：`source === root || parentOf(source) === root` 直接返回，避免 `renameEntry` 的 E_INVALID 误报"移进自身"），成功反馈「已移动：X → 工作区根」。
- **移动语义收敛到主进程 `renameEntry`**（跨目录即移动），成功后前端**双目录刷新**（源父目录 + 目标父目录，`refreshNodeNow`；根层退化为 reloadTree）并做 **tab 路径迁移**（精确匹配 + 前缀匹配）、`disposeModel` 旧路径、迁移 activePath + `reloadSignal`。
- **与系统文件拖入互不干扰**：窗口级拖拽监听（§10.6）只认 `Files` 类型，内部拖拽自定义 MIME 自然放行。
- 范围限制：不支持同级插入排序、覆盖（同名冲突报 `E_EXIST` 拒绝）、跨设备 fallback（EXDEV 报错提示）。

### 10.6 拖拽打开（系统文件/文件夹 → 工作区/标签）

**窗口级监听**（App.tsx）：`window` 上 capture 阶段挂 `dragover`/`dragleave`/`drop`，先于 Monaco 等内部 drop 处理执行：

- **仅拦截携带 `Files` 类型数据的拖拽**（`dataTransfer.types` 含 'Files'）；纯文本/HTML 拖放放行给编辑器。`dragover` 必须 `preventDefault`（否则 Chromium 默认导航到 `file://` 且 drop 不触发），`dropEffect='copy'`，置位 `dragActive` 显示全局遮罩（"松开以打开文件 / 文件夹"，`pointerEvents:none` 不拦截事件）。`dragleave` 仅在 `relatedTarget` 为 null（拖出窗口边界）时清除遮罩。
- **drop 处理**：`preventDefault + stopPropagation`（文件拖入整体由应用接管，不落到编辑器）→ `dataTransfer.files` 逐个 `getPathForFile(f)`（`webUtils.getPathForFile`，**Electron 44 中 `File.path` 已移除**）→ `dropOpen(paths)`。
- **主进程判定**（`FileSystemService.dropOpen`）：遍历路径——目录取第一个合法目录经 `openDirectoryAt`（`validateRootCandidate` 准入）设为新工作区根；文件收集；**只有文件且不在当前根内**（含首启无根）→ 以第一个文件的父目录为工作区根；返回 `{ root, files }`，files 已按 containment 过滤（`isInside` 前缀比较，读不了的不发给渲染层）。
- **渲染层执行**（`handleDropPaths`）：`root` 非空 → `openFolderAt(root)` 切换工作区；`files` 逐个 `openFile` 开标签；状态栏反馈（多文件「已打开 N 个文件」/ 单文件「打开：<name>」/ 仅切根「工作区：<root>」）。

---

## 11. 开发与运营

### 11.1 脚本矩阵（对照 package.json）

| 命令 | 作用 | 实现 |
|---|---|---|
| `pnpm dev` | 前台启动开发（electron-vite dev，终端被占用） | 内置 |
| `pnpm start` | 同 dev；**启动前自动停止本服务旧实例** | `scripts/dev-daemon.mjs start` |
| `pnpm start --daemon` | **后台**启动：日志写 `log/dev-daemon.log`，PID 写 `pid/dev-daemon.pid` | `dev-daemon.mjs start --daemon` |
| `pnpm status` | 查询运行状态（pid 文件/存活进程/端口占用），陈旧 pid 自动清理 | `dev-daemon.mjs status` |
| `pnpm stop` | **三重识别**本服务所有进程并全部终止，孤儿也清得掉 | `dev-daemon.mjs stop` |
| `pnpm clean` | 删除 `out/` `dist/` + dev-daemon 运行时目录 `log/` `pid/` + electron-vite 临时 config bundle（`electron.vite.config.*.mjs`） | `scripts/clean.mjs` |
| `pnpm clean deep` | 再删 `node_modules/` + `pnpm-lock.yaml`（彻底重装） | `clean.mjs deep` |
| `pnpm build` / `preview` | 构建 / 预览（产物在 out/） | 内置 |
| `pnpm dist*` | 打包当前/指定平台安装包（§12.2） | `scripts/dist.mjs` |
| `pnpm typecheck` / `lint` / `lint:fix` / `check` | 类型检查 / ESLint / 修复 / **check=typecheck+lint 任一不过非零退出** | 内置（tsc --noEmit / eslint .） |
| `pnpm e2e` | CDP 端到端测试 | `scripts/e2e/run.mjs` |
| `postinstall` | `node node_modules/electron/install.js`——electron 44 起二进制由安装脚本补装（§11.3） | package.json |

### 11.2 dev-daemon 架构（`scripts/dev-daemon.mjs`）

- **后台模式两层结构**：`start --daemon` 先 spawn 一个**常驻 supervisor**（`node dev-daemon.mjs run`，`detached:true`，stdio 接日志），supervisor 再拉起 electron-vite。pid 文件由 supervisor 持有：
  - electron-vite 正常退出（用户点窗口关闭）→ supervisor **自动清理 pid 文件**后退出（杜绝"窗口关了但 pid 残留"）；
  - supervisor 收到 SIGTERM/SIGINT → 转杀 electron-vite、清 pid、退出；
  - supervisor 是**新进程组组长**，`stop` 的 `kill(-pid)` 一次带走整棵进程树（Electron 主+GPU+渲染+utility 共 4+ 个 Chromium 子进程一并清理——`pnpm stop` 显示多进程是正常架构，不是泄漏）。
- **进程识别（三重判定）**，覆盖纯 pid 文件的盲区：
  1. **pid 文件**：要求进程存活**且命令行确属本项目**（`ps -ww -p <pid> -o command=` 校验含本项目 node_modules 路径）——防 pid 被系统复用后误杀。
  2. **进程名扫描**：`ps -axww -o pid=,command=` 全表扫描（`-ww` 防截断），匹配规则 `isOurs()` = **命令行含本项目 root（归属）+ 含 `dev-daemon.mjs run`（supervisor 自识别）或含无前缀的 `node_modules/electron-vite/` / `node_modules/electron/dist/` 子串（身份）**。**不能用 `${root}/node_modules/electron/dist/` 带 root 前缀字面匹配**——pnpm 符号链接布局下真实命令行是 `node_modules/.pnpm/electron@x.y.z/...`，前缀锚定会漏掉全部 Electron 进程（曾导致 stop 杀不掉窗口）。supervisor 用 `dev-daemon.mjs run` 而非裸文件名匹配，避免误伤"编辑器恰好打开这个脚本文件"的进程。
  3. **端口探测**：`lsof -ti tcp:5173 -sTCP:LISTEN`（`DEV_PORT` 可覆盖）；监听者属本服务则纳入停止，属**无关进程**则 `start` 拒绝启动（`DEV_PORT=<端口>` 换端口），绝不误杀。
- `stop`：先 `process.kill(-pid, 'SIGTERM')` 杀进程组（含单进程 SIGTERM 兜底），轮询最多 3s 未退出再 SIGKILL 兜底，终检（sleep 500ms 后重新扫描）残留孤儿再强杀，最后清 pid 文件。
- `start`：`preflight()` 先跑三重识别，发现旧实例自动停止后再启动；确认端口无无关占用。
- spawn 一律用包内**真实 JS 入口** `node_modules/electron-vite/bin/electron-vite.js`——不能 spawn `node_modules/.bin/electron-vite`（shell 包装脚本被 node 当 JS 跑直接 SyntaxError，曾导致"报已启动但窗口不出现"）。
- **刻意剥离 `ELECTRON_RUN_AS_NODE`** 再启动：该环境变量残留会让 electron 以纯 Node 模式启动崩溃，`cleanEnv()` 在 spawn 前删掉。
- 跨平台统一 `node <bin> dev`（`shell:false`）。

**运行产物**：`pid/dev-daemon.pid` / `log/dev-daemon.log`（两目录已加入 `.gitignore`；`pnpm clean` 整目录清理，清理前先 `pnpm stop`）。

### 11.3 pnpm 11 构建脚本审批（必读）

pnpm 11 默认**拒绝执行依赖的安装期构建脚本**（postinstall），`electron` 与 `esbuild` 均依赖 postinstall 下载平台二进制。未显式批准会报 `ERR_PNPM_IGNORED_BUILDS` 并以 exit 1 失败。**关键变更**：pnpm 11 已**移除 `package.json` 的 `"pnpm"` 字段**，改用 `pnpm-workspace.yaml` 的 `allowBuilds` 映射（`包名: true`，非数组）。本项目已批准 `electron: true` / `esbuild: true` / `electron-winstaller: false`（Windows 专用，macOS 开发机不需要）。升级 pnpm 大版本或新增需构建的原生依赖，须同步把包名加入 `allowBuilds`（或本地 `pnpm approve-builds`，它会把待审项写回 yaml）。

> **⚠️ Electron ≥42 例外（本项目 electron ^44，已生效）**：`electron@42` 起 package.json **移除了 postinstall 脚本**（安装器改由 `install-electron` bin 暴露，`pnpm` 只执行 `scripts` 中的生命周期脚本，因此 `allowBuilds` 对 electron 不再生效，重装依赖后二进制不会自动下载）。已**固化到项目自身 lifecycle 脚本**：package.json `"postinstall": "node node_modules/electron/install.js"`——每次 `pnpm install` 后自动补装平台二进制（校验 `node_modules/electron/dist/version` 与 `path.txt`）。临时补装亦可手动执行该命令。electron <42 不受影响（仍有 postinstall，走 allowBuilds）。

**首次从 npm 迁移到 pnpm**：若 node_modules 是 npm install 留下的，pnpm 会移入 `.ignored` 并判定不同步。建议：
```
pnpm clean deep   # 删 node_modules/ 与 pnpm-lock.yaml
pnpm install      # esbuild 走 allowBuilds；electron 二进制由 postinstall 脚本补装
pnpm start --daemon
```

### 11.4 CDP 端到端测试（`scripts/e2e/`，零 npm 依赖）

`pnpm e2e` 跑真实 dev 实例的 UI 行为测试（Node ≥ 22 原生 WebSocket + fetch，**不引入任何新包**）。与单元测试互补：直接验证 §8.2 冲突矩阵 / §7.3 保存反馈 / §7.4 自动保存这些"跨进程时序敏感"的行为。

**运行机制**（`run.mjs`）：
- 在 `FileSystemService.openDirectoryDialog` 注入临时 `EIF_AUTO_DIR` 钩子（env 指定目录时绕过系统 dialog，**测试后自动还原原文**，启动时发现上次中断残留会先自愈还原）；
- 在 `/tmp/eif-e2e-ws` 准备测试工作区（hello.txt / readme.md）；
- spawn `electron-vite dev`（剥离环境残留变量，见 PIT-2），等 CDP 9222 就绪；
- 依次跑 5 个场景，断言计数汇总；`finally` + `process.on('exit')` 双重兜底还原钩子、停 dev、清理工作区。

**覆盖场景**：S1 手动保存「保存成功」反馈；S2 外部修改提示条 +「重新加载外部版本」二次确认（取消保留 / 确定加载）；S3「保留当前版本」不清 dirty、随后保存 force 覆盖外部修改；S4 自动保存定时器路径（反馈 + 落盘 + dirty 清除 + 无 dirty 不提示）；S5 clean 文件外部修改 → 自动重载（无提示条 / 无 modal）。

**文件结构**：`run.mjs`（主编排 + 5 场景）/ `cdp-client.mjs`（CDP WebSocket 客户端）/ `app-helpers.mjs`（应用层 UI 操作与断言）/ `util.mjs`（sleep / 断言计数器）/ `README.md`（用法 + 全部 PIT 坑清单）。

**历次排障沉淀的 PIT 清单（改测试前必读，`e2e/README.md` 完整收录）**，其中两条直接关联本文档设计决策：
- **PIT-18 selfWriteTracker TTL（严重）**：§5.5 `SELF_WRITE_TTL=1000ms` —— 应用保存/写盘后 1s 内对同一路径的**外部写也会被 `isSelf()` 误判为 self**（走 self 分支，提示条/自动重载都不触发）。套件里"先保存、后测外部修改"同一文件时，外部写前必须 `sleep(1500)` 等 TTL 过期。
- **PIT-16 localStorage 残留会污染 dirty 场景（严重）**：§7.4 自动保存设置持久化在 localStorage，若上次运行残留"自动保存开启"，定时器会在制造 dirty 后 2s 内抢先保存清掉 dirty，提示条场景全部失效——套件开局必须 `localStorage.clear()` + `location.reload()`（`resetRendererState` 已处理）。
- 其余：PIT-1 冷启动慢（~30-40s，轮询 `/json/list`）、PIT-2 环境变量残留（`ELECTRON_RUN_AS_NODE` / `CODEBUDDY_*` 必须删，同 §11.2 的 `cleanEnv`）、PIT-5 Monaco 0.56 输入区类名 `.ime-text-area` 且需真实鼠标点击、PIT-7 CDP insertText 前导空格转 NBSP（断言不依赖 ASCII 空格）、PIT-13 Monaco model 按路径复用不读盘（完整重跑前重启 dev）、PIT-17 `el.click()` 无返回值等。

---

## 12. 打包与分发

### 12.1 electron-builder 三端配置（对照 electron-builder.yml）

| 端 | 目标 | 签名 |
|---|---|---|
| macOS | dmg（x64 + arm64 双架构） | `hardenedRuntime` + 最小权限 entitlements（`build/entitlements.mac.plist`：allow-jit / allow-unsigned-executable-memory / disable-library-validation，**不开 app-sandbox**——需自由读写用户选定的工作区）；无证书本地打包自动降级 ad-hoc（`dist.mjs` 检测 `CSC_LINK`/`CSC_KEY_PASSWORD` 为空时附加 `-c.mac.identity=- -c.mac.hardenedRuntime=false`，本机可跑，外发被 Gatekeeper 拦但可"右键→打开"）；正式分发配 `CSC_LINK`/`CSC_KEY_PASSWORD`，公证再配 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` |
| Windows | NSIS（x64 + arm64，用户级安装：`oneClick:false` + `allowToChangeInstallationDirectory:true` + `perMachine:false` + `deleteAppDataOnUninstall:false`） | 可选但强烈建议：`CSC_LINK`（.pfx 或 base64）/`CSC_KEY_PASSWORD` 自动调 signtool（sha256，`signingHashAlgorithms` 必须放 `win:` 块内），否则 SmartScreen 拦截 |
| Linux | AppImage + deb（x64 + arm64） | 无需证书；deb `maintainer` 必填（默认 `sounds-great-ai <rouroumaibing@qq.com>`，可用 `--email`/`DIST_EMAIL` 覆盖） |

- appId `com.soundsgreat.fileeditor`，productName `FileEditor`，`files: [out/**]`（只打包构建产物），`asar: true`。
- 图标：`build/icon.png`（1024×1024，程序化生成），electron-builder 自动转 icns/ico。
- 构建命令矩阵见 §12.2；CI 四层发布链路见 §12.3 与 `docs/ci-release-pipeline.md`（该文档已与 workflow 核对一致，含 mac 架构矩阵 arm64→macos-latest / x64→macos-15-intel、临时 keychain 导入、`checksums` 汇总 job 合并双架构 SHA256SUMS.mac、attest-build-provenance、softprops attach 等）。

**C1 本地实测记录（2026-08-29，macOS x86_64 无证书环境）**：✅ 打包全链路通过。`electron-vite build`（33.8s）→ `electron-builder --mac` → `FileEditor.app`（`Contents/Resources/` 含 `app.asar` 与自动转换的 `icon.icns`）→ `FileEditor-0.1.0.dmg`（369MB）。签名按预期跳过（Intel 本机运行不受 Gatekeeper 限制；外发需配证书）。两个环境坑：①`signingHashAlgorithms` 必须放 `win:` 块内，放根级会被 schema 校验打回；②在 WorkBuddy 沙箱/代理环境跑 electron-builder，其 `NODE_OPTIONS=--require=...shim.cjs` 注入会拦 `.asar` 遍历（`Invalid package ... default_app.asar`）——用 `env -u NODE_OPTIONS` 绕过；沙箱还拒 `/Volumes` 挂载写入导致 dmg 失败——用 `hdiutil create -volname FileEditor -srcfolder dist/mac -ov -format UDZO dist/<name>.dmg` 直出。**用户在自己终端跑 `pnpm dist:mac` 无此问题**。

### 12.2 dist.mjs 命令矩阵

`scripts/dist.mjs` 统一封装（先 `electron-vite build` 再 electron-builder；**按平台循环调用**，注入 `-c.directories.output=dist/<platform>/`——`directories.output` 是全局配置，多平台同批构建会混入同一目录，故拆开）：

| 命令 | 产物 |
|---|---|
| `pnpm dist` | 当前平台全部架构（x64 + arm64） |
| `pnpm dist:mac` / `:mac:x64` / `:mac:arm64` | macOS dmg → `dist/mac/` |
| `pnpm dist:win` / `:win:x64` / `:win:arm64` | NSIS exe → `dist/win/` |
| `pnpm dist:linux` / `:linux:x64` / `:linux:arm64` | AppImage + deb → `dist/linux/` |
| `pnpm dist:all` | mac + win + linux 全平台（mac 仅限 macOS 主机，非 macOS 自动跳过并提示） |

**产物目录分层**：`out/`（electron-vite 中间产物，main/preload/renderer）与 `dist/<platform>/`（安装包）分离；每平台子目录内附 `SHA256SUMS.<platform>`（CI 生成，见 §12.3）。`pnpm clean` 整删 `out/` 与 `dist/`。

- **邮箱**：`pnpm dist --email you@example.com` 或 `DIST_EMAIL=...`，注入 deb maintainer（`sounds-great-ai <email>` 格式归一化；默认值三处一致：electron-builder.yml / dist.mjs / package.json author）。
- **透传**：`pnpm dist -- --dir`（出未打包目录快速验证）；`--arch` 支持 `x64`/`arm64`/`all`；`--platform` 支持 `mac,win,linux` 逗号组合；`--dry-run` 只打印解析结果与最终 builder 参数（注意必须不带 `--`）。
- **跨平台硬约束**：mac 产物只能在 macOS 构建（签名/dmg 工具链限制），显式指定直接报错、`dist:all` 自动跳过；win/linux 可交叉（win 首次交叉会下载 NSIS，部分场景需要 wine）。项目**无原生依赖**（纯 JS），异构架构构建无需额外工具链。
- **版本注入**：`--version <v>` 经 `-c.extraMetadata.version` 注入（semver 正则校验 `/^\d+\.\d+\.\d+/`；不改写 package.json——文本改写脆弱，`extraMetadata` 是 electron-builder 原生通道）。版本纪律见 `docs/ci-release-pipeline.md §6.5`。
- **mac 无证书自动降级 ad-hoc**：`hasSigningCred = Boolean(CSC_LINK || CSC_KEY_PASSWORD)`；无凭据且宿主为 darwin 时附加 `-c.mac.identity=- -c.mac.hardenedRuntime=false`（`hardenedRuntime` 必须同关，否则 ad-hoc 的 app 无法右键打开）。

### 12.3 CI 四层发布链路

详见 `docs/ci-release-pipeline.md`（L0 验证 ci.yml → L1 编排 release-desktop.yml → L2 三平台构建 → L3 分发 + SHA256SUMS + attestation；5 个 workflow 均已核对一致）。要点摘要：

- `ci.yml`：push/PR 纯验证（frozen install + check + build 冒烟），零产物；`paths-ignore` 排除 `docs/**`、`README*`、`**/*.md`（文档改动不排队）。
- `release-desktop.yml`：`release.published`（打 tag + 建 Release + 点 Publish 才触发）或 `workflow_dispatch`（dry-run 只产 artifact）；`resolve-version` 统一版本解析（strip v）。
- 签名凭据全走 GitHub Secrets（`secrets: inherit`），缺凭据自动降级（mac → ad-hoc，win → 未签名）。

---

## 13. 演进与取舍

### 13.1 转插件预留

1. **`FileSystemService` 接口先行**：接口本身与"是不是 Electron"无关，未来宿主提供自己的文件系统 API 时，只写新实现去适配，IPC handler 与前端调用基本不用改。
2. **UI 不依赖 Electron 特有能力**：组件只经 `window.fileAPI` 抽象访问数据，不直接 `import('electron')`，可被任何提供同样契约的宿主环境使用（Electron 插件系统 / VSCode Webview 沙箱）。例外：拖拽打开依赖 `webUtils.getPathForFile`（§10.6），转宿主时需等价替换。

确定具体目标宿主后，需针对其"渲染进程能拿到什么能力"的限制调整 IPC/API 桥接方式。

### 13.2 健壮性 backlog

- **Monaco Model 生命周期**（§7.2）：关闭标签必须 dispose，防泄漏——已实现（`modelRegistry.disposeModel`，关闭/重命名/删除/批量关闭全覆盖）。
- **Monaco 离线 worker（已完成 ✅）**（§7.1）。
- **chokidar 忽略规则（必选项非可选项）**（§5.6 / §9.5）。
- **IPC 错误落地**：领域错误走 §3.1 信封、transport error 走 reject（`TransportError`）；前端显式分支（E_NOENT→"文件已被删除"、E_PERM→"权限不足"、E_ESCAPE→"无权访问"、E_UNSUPPORTED→"不支持预览"、E_TOOBIG→"文件过大"、E_INVALID→"不能移进自己"）。E_CONFLICT 仅主进程 API 防御用（§7.3 改版：渲染层保存恒 force，UI 不再出现该错误文案）。
- **历史章节号漂移**：源码注释中的 § 引用（§14/§15/§17 等）为旧版编号，与本文档不对应（见文件头说明）。若后续大规模修订，应同步清理注释引用，避免误导。

### 13.3 已知取舍（主动不做）

| 不做 | 理由 |
|---|---|
| 崩溃自动保存/会话恢复 | "查看+编辑"定位，关闭即丢弃未保存内容（§7.4 产品决策） |
| Office/PDF 渲染 | 文档查看器范畴，超出定位（§6.6） |
| 应用内自动更新（electron-updater） | 本地工具 + 手动下载分发已够；updater 要求正式签名 + 发布元数据 + CI 配套，对单人项目是纯重资产（ci-release-pipeline.md §6.5） |
| 全盘文件索引/Everything 式搜索 | 单工作区场景用懒加载树 + 事件增量已最优；MFT 直读是 NTFS 专属，macOS 无对应（§9.1） |
| SBOM 生成 | 依赖锁定由 pnpm-lock + frozen install 保证；规模化后再补 |
| 目录规模防腐化 | 项目文件数远低于阈值，收益不抵维护成本 |
| 外部删除的"文件已被外部删除"横幅 | v3 曾规划；当前实现以 §8.2 矩阵（clean→自动重载失败提示 / dirty→提示条）为准，未单独立分支 |

---

## 14. 验收门禁

### 14.1 阶段 1 问答（设计完备性）

文档定稿后必须能回答：

1. 前端收到任意 `FsChangeEvent` 怎么反应？（§3.3 + §8.2）
2. 目录节点任何时刻处于哪种 loadState，UI 如何呈现？（§3.2 + §10.1）
3. 任一 IPC 调用失败，前端如何分支？transport error 与领域错误如何区分？（§3.1）
4. 外部改动 vs 未保存编辑相遇，用户看到什么、能选什么？（§8.2）
5. 事件 source 如何判定、renamed 事件如何产生？（§5.5）
6. 保存时如何防"事件丢失导致的静默覆盖"？（§7.3：主进程 API 层乐观并发防御保留；渲染层保存恒 force，外部改动可见性由 §8.2 非阻塞提示条承担）
7. 任一路径操作如何防止穿越工作区根？（§4.2）
8. 大文件 / 二进制 / 非 UTF-8 / 换行符分别走哪条链路？（§6）
9. 拖入系统文件/文件夹到窗口发生了什么？（§10.6：主进程判型设根 + containment 过滤 + 打开指令）
10. git 状态何时刷新、如何降级？（§10.4：仅打开工作区 + 事件后触发，主进程 2s 节流 + in-flight，非仓库本会话关闭）

全部有明确结论即视为阶段 1 通过。

### 14.2 实现状态对照（2026-08-30 两次按代码核对：v4 18:17 / v5 18:25）

| 设计项 | 状态 |
|---|---|
| 三进程隔离 + sandbox（生产 true / dev false） | ✅ 已实现 |
| containment（assertWithinRoot + resolveExistingAncestor）+ validateRootCandidate | ✅ 已实现 |
| probeFile 预检（BOM/NUL/大小/魔数）+ UTF-8 无 BOM + EOL 闭环（model.setEOL） | ✅ 已实现 |
| readImage 图片链路 + ImageViewer + FilePreviewGate 分流 | ✅ 已实现 |
| selfWriteTracker（TTL 1000ms）+ 外部 renamed 合成（200ms 缓冲） | ✅ 已实现 |
| E_CONFLICT（改版：保存恒 force 覆盖，仅 API 防御）+ 快照回写/迁移/删除 | ✅ 已实现 |
| chokidar 4（depth:0 / ignoreInitial / 忽略 node_modules/.git，**无 useFsEvents**） | ✅ 已实现 |
| 事件去抖 150ms + in-flight 合并 + 根层退化 + 展开态恢复 + watch 回收 | ✅ 已实现 |
| 右键菜单集中新建 + 空白区入口（工作区根）+ 嵌套新建 revealDirectory | ✅ 已实现 |
| 树内拖拽移动（自定义 MIME + 目录落点 + 自子树守卫 + 根落点）+ 拖拽打开（dropOpen） | ✅ 已实现 |
| 可靠编辑三件套（关闭提示/定时保存/undo-redo）+ 批量关闭页签 | ✅ 已实现 |
| Git 状态高亮（porcelain v1 + 2s 节流 + 目录聚合 + 降级） | ✅ 已实现 |
| dev-daemon（两层结构 + 三重识别）/ clean / pnpm 11 allowBuilds / postinstall | ✅ 已实现 |
| CI 四层发布链路 + 版本纪律（5 个 workflow 核对一致） | ✅ 已实现（见 ci-release-pipeline.md） |
| meta 生命周期闭环（modelMeta 表 + openFile 同步恢复 + 复用分支补报） | ✅ 已实现（2026-08-30 修复） |
| CDP e2e 套件（5 场景 + 钩子注入/还原 + PIT 清单） | ✅ 已实现（`scripts/e2e/`，§11.4，v5 补录） |

---

## 附录 A：版本差异摘要（v3→v4 按代码修正点 + v4→v5 核验修正点）

### A1. v4 按代码修正点（相对 v3，2026-08-30 18:17）

| # | 主题 | v3 旧表述 | v4 实际（代码为准） |
|---|---|---|---|
| 1 | chokidar 监听参数 | `useFsEvents: true` | **chokidar 4 已移除 `useFsEvents`**，macOS 恒用 FSEvents（§5.6/§9.5） |
| 2 | 错误码全集 | 无 `E_INVALID` | `E_INVALID`（renameEntry 自子树守卫，§3.1/§5.2） |
| 3 | git 契约 | `readGitStatus(): Promise<FsResult<GitStatusSnapshot>>`，非仓库返回 ok:true+enabled:false | **`readGitStatus(workspaceRoot): Promise<GitStatusSnapshot>` 裸快照无信封**，非仓库直接 `{enabled:false}`（§3.5/§3.6/§10.4） |
| 4 | fileAPI 契约 | 缺 dropOpen / getPathForFile / onRequestClose / confirmClose | 19 成员全集，含拖拽打开与关闭拦截通道（§3.6） |
| 5 | probe 语义 | "large → E_TOOBIG；binary → E_UNSUPPORTED"（probe 层） | probe 对 large/binary **返回 ok:true + category 标记**，readFile 才转错误（§3.4/§6.1） |
| 6 | 隐藏条目过滤 | "顶级隐藏项 MVP 期直接过滤" | **所有层级**过滤 `.` 开头条目（§5.1） |
| 7 | createDirectory | 隐含 E_EXIST 语义 | `mkdir recursive` **幂等，无 E_EXIST 检查**（§5.2） |
| 8 | 拖拽打开 | §10.1 侧车提及 | 独立小节 §10.6：window capture 监听 + `webUtils.getPathForFile`（Electron 44 File.path 已移除）+ dropOpen 判定 |
| 9 | CodeEditor 细节 | 未明确 | loadingRef 加载期不标 dirty；回调经 ref 调用防 effect 重跑；`automaticLayout`+`theme:'vs'`；CtrlCmd+S（§7.1） |
| 10 | Git 装饰细节 | 未明确 | `mapCode` XY 规则（`??`→U、`!!` 跳过、unmerged→C）；`disabledForSession`；status 超时沿用旧缓存；`GIT_PRIORITY`（R 同 M）；目录聚合无徽标；徽标 `C`→`!`（§10.4） |
| 11 | 外部删除横幅 | v3 描述"文件已被外部删除"横幅 | 当前实现未单独立分支，按 §8.2 矩阵处理（§8.3/§13.3） |
| 12 | 脚本/打包 | 大体一致 | 补 `postinstall`、`e2e`、`--dry-run`、ad-hoc 降级条件（CSC_LINK\|CSC_KEY_PASSWORD）、`darkModeSupport:false` 等（§11/§12） |
| 13 | 注释章节引用 | — | 新增说明：源码注释 § 引用为历史编号，与本文档不对应（文件头） |

### A2. v5 核验修正点（相对 v4，2026-08-30 18:25，逐文件比对）

| # | 主题 | v4 表述 | v5 修正（代码为准） |
|---|---|---|---|
| 1 | 备份链 | archive 仅列 `2026-08-30 / 2026-08-30-1830` | 补本次重写前备份 `2026-08-30-1822`（§2.2 / 文件头）；v5 完成后**备份已按用户要求删除**，历史版本以 git 记录为准 |
| 2 | e2e 目录 | 仅列 run / cdp-client / app-helpers / util 四文件 | 补 `README.md`（§2.2）；新增 §11.4 完整描述 e2e 套件（5 场景 + 钩子注入/还原 + PIT 清单，含 PIT-18 TTL 与 PIT-16 localStorage 两条与本文档设计直接相关） |
| 3 | 实现状态对照 | 缺 e2e 项 | §14.2 补 `CDP e2e 套件 ✅ 已实现` |
| 4 | Git 装饰颜色机制 | v4 写"颜色走 CSS 变量" | **`FileTree.tsx` 的 `GIT_COLORS` 常量表 + inline style**（项目无 CSS 变量体系，样式全在 `styles.ts`，§10.4） |
| 5 | 核验范围 | 文件头声明对照 src/scripts/package.json 等 | 明确 28 个源文件 + 5 workflow + 4 脚本 + 配置全量核验；并诚实记录"未列修正即代表 v4 与代码相符，不为改而改" |

*本文档以 `src/`、`scripts/`、`package.json`、`electron-builder.yml`、`electron.vite.config.ts`、`pnpm-workspace.yaml`、`.github/workflows/` 实际代码为准，随代码变更联动更新。代码注释中的旧章节号引用建议在后续修订中逐步清理对齐。*
