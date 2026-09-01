# electron-file-editor 设计文档（v6 · 基于代码重新梳理版）

> 本文档于 2026-09-01 对照 `src/` 真实代码重新梳理重写，覆盖 `main` / `preload` / `renderer` / `shared` 四层。
> 旧版（v5.1）已归档为 `docs/electron-file-editor-design.md.bak-20260901-1244`，仅作历史对照，不再维护。
> 文档内所有 § 编号与设计点均以当前代码为准；若代码与本文冲突，以代码为权威（如发生漂移，先修代码或同步更新本文）。

---

## 1. 产品定位与设计原则

### 1.1 定位

VSCode 风格的「文件浏览 + 文本编辑」Electron 应用，macOS 单平台 MVP 脚手架。核心能力：打开文件夹 → 懒加载文件树 → 多标签编辑文本 / 预览图片 → 保存回盘 → 监听外部改动并局部刷新。附带 Git 状态装饰（可选增强，默认开启）、暗/亮双主题、左右面板自由置换。

### 1.2 设计原则

- **前端永不直接碰 `fs`**：所有磁盘操作经主进程 `FileSystemService` 单一汇聚点（`src/main/services/FileSystemService.ts`），渲染层只持有路径字符串，containment 校验全部在主进程完成。
- **最小权限**：`contextIsolation: true` + `nodeIntegration: false`；`sandbox` 仅 dev 临时关闭（Mac 未签名二进制跑 sandbox 必报 `sandbox initialization failed`），生产打包（`electron-builder.yml` 配 `entitlements.mac.plist`）保持 `sandbox: true`。
- **真实路径不泄露**：`FsError.path` 仅用于主进程本地日志；`ipcMain.handle` 返回值经 `toClientError` 结构化剥除 `path` 后才发往渲染层（见 §3.1 / §5）。
- **懒加载 + 事件驱动**：文件树只加载一层，展开才向下加载；外部改动经 `fs:changed` 事件局部刷新，避免整树频繁重载。
- **产品决策**：查看/编辑工具，关闭窗口 = 整个应用退出（含 dev 期 electron-vite 进程链），不走 macOS「关窗留 Dock」惯例（见 `src/main/index.ts` 注释）。

### 1.3 关键技术栈（对照 `package.json` 实际版本）

| 类别 | 依赖 | 版本 |
| --- | --- | --- |
| 运行时 | electron | ^44.0.0 |
| 构建 | electron-vite / electron-builder / vite | ^5.0.0 / ^26.15.3 / ^7.3.6 |
| 框架 | react / react-dom | ^19.2.8 |
| 编辑器 | monaco-editor / @monaco-editor/react | ^0.56.0 / ^4.7.0（本地打包，离线可用） |
| 监听 | chokidar | ^4.0.3 |
| 编码 | iconv-lite | ^0.7.3（仅 BOM 明确的 UTF-16 解码） |
| 类型/检查 | typescript / eslint / typescript-eslint | ^6.0.3 / ^10.9.1 / ^8.68.0 |

> **Monaco 离线**：`@monaco-editor/react` 默认从 CDN 拉运行时，`monacoSetup.ts` 改用本地打包 `monaco-editor` 并配置 web worker（`loader.config({ monaco })`），完全离线可用。必须在任何 `loader.init()` 之前执行（`main.tsx` 顶部 `import './monacoSetup'`）。

---

## 2. 系统架构

### 2.1 三进程模型

```
┌──────────────────────────────────────────────────────────────┐
│ main 进程 (Node)                                              │
│  FileSystemService（磁盘唯一汇聚点）  GitStatusService（装饰）  │
│  ipcMain.handle / ipcMain.on      pushEvent('fs:changed')      │
└───────────────▲───────────────────────────┬──────────────────┘
                │ invoke / send              │ webContents.send
                │                            │
┌───────────────┴───────────────────────────▼──────────────────┐
│ preload (contextBridge 白名单)  →  window.fileAPI             │
└───────────────▲───────────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────────┐
│ renderer 进程 (React)  App → FileTree / CodeEditor / Image…    │
│  hooks/useFileAPI  modelRegistry  theme  styles                │
└───────────────────────────────────────────────────────────────┘
```

- **main**：`BrowserWindow` 隔离配置（`src/main/index.ts`），初始化 `FileSystemService` 与 `GitStatusService`，注册 IPC handlers，把 `FsChangeEvent` 经 `mainWindow.webContents.send('fs:changed', ...)` 推送渲染层。
- **preload**：`contextBridge.exposeInMainWorld('fileAPI', {...})` 白名单暴露，禁止暴露整个 `ipcRenderer`。
- **renderer**：React 状态机，经 `useFileAPI` 薄封装调用 `window.fileAPI`，不直接触达 Node。

### 2.2 目录结构（实际文件）

```
src/
  main/
    index.ts                 # 入口：窗口、handler 注册、主题/关闭 IPC
    services/
      FileSystemService.ts   # 磁盘操作唯一汇聚点
      GitStatusService.ts    # git 状态采集（装饰数据源）
    ipc/
      fsHandlers.ts          # fs:* / dialog:* / fs:dropOpen
      gitHandlers.ts         # git:status
  preload/index.ts           # window.fileAPI 白名单
  shared/types/
    fs.ts                    # 契约类型真源（FsResult/FsError/FileNode/...）
    git.ts                   # GitStatusSnapshot / GitStatusCode
  renderer/
    main.tsx                 # 引导（先 import monacoSetup）
    App.tsx                  # 顶层布局与状态编排
    theme.ts                 # 双主题令牌 + 持久化 + 文件色映射
    styles.ts                # createStyles(tokens) 内联样式工厂
    modelRegistry.ts         # 按 filePath 维护 Monaco model + meta
    monacoSetup.ts           # Monaco 本地化 + worker
    settings.ts              # 自动保存 / 分栏宽度 localStorage
    electron.d.ts            # window.fileAPI 类型
    hooks/useFileAPI.ts      # fileAPI 薄封装（transport/领域错误分流）
    utils/lang.ts            # 扩展名 → Monaco language id
    components/
      FileTree.tsx CodeEditor.tsx ImageViewer.tsx
      FilePreviewGate.tsx UnsupportedViewer.tsx
      InputModal.tsx ConfirmModal.tsx CloseConfirmModal.tsx SettingsModal.tsx
```

> **类型落点约定**：契约类型只在 `src/shared/types/` 定义，main / renderer 都经 `tsconfig` paths 别名 `@shared` 引用，不复制、不漂移（`src/shared/types/fs.ts` 注释）。

### 2.3 数据流总览

```
openDirectoryDialog ─┐
拖拽打开 dropOpen ───┴─► workspaceRoot ─► readDirectory(根) ─► 构建文件树
                                                         │
                              点击目录 ► toggleDir ─► readDirectory(子) ─► 懒加载一层 + watch
                              点击文件 ► openFile ─► probeFile + readFile ─► Monaco model / ImageViewer
                                                         │
       保存（Cmd+S/按钮/关闭保存/自动保存）─► writeFile(path, content, {force:true})
                                                         │
  外部改动 ─► chokidar ─► FileSystemService ─► 'fs:changed' ─► App 按 §8 矩阵处理
```

---

## 3. 共享契约（类型真源 `@shared/types`）

### 3.1 错误契约（`FsResult` / `FsError`）

```ts
export type FsErrorCode =
  | 'E_NOENT' | 'E_PERM' | 'E_EXIST' | 'E_ISDIR' | 'E_NOTDIR'
  | 'E_TOOBIG' | 'E_ESCAPE' | 'E_UNSUPPORTED' | 'E_CONFLICT' | 'E_INVALID' | 'E_UNKNOWN';

export interface FsError { code: FsErrorCode; message: string; path?: string; }
export type FsResult<T> = { ok: true; data: T } | { ok: false; error: FsError };
```

- `FsError.path` **仅主进程本地日志用**。渲染层经 `ipcRenderer.invoke` 拿到的返回值会被结构化克隆完整发送，故 `fsHandlers.ts` 的 `wrap()` 在 return 前统一调 `toClientError(error)` 剥除 `path`：

```ts
function toClientError(error: FsError): FsError {
  const { path: _omit, ...rest } = error;
  return rest;
}
```

- `gitHandlers.ts` 不经 `toClientError`——git 状态只含路径（已按 workspaceRoot 重定位为绝对路径）不含敏感内容，且非仓库返回 `{ enabled: false }` 而非错误。

### 3.2 目录节点（`FileNode` 状态机）

```ts
export type NodeLoadState = 'unloaded' | 'loading' | 'loaded' | 'empty' | 'error';
export interface FileNode {
  name: string; path: string; type: 'file' | 'directory';
  children?: FileNode[];
  loadState?: NodeLoadState;   // 仅 directory：子节点加载状态
  loadError?: string;          // loadState==='error' 时可读信息
  expanded?: boolean;          // UI 状态：是否展开（不决定 loadState）
}
```

- `readDirectory` 返回的目录节点 `loadState: 'unloaded'`、`expanded: false`；点击展开后变 `loading → loaded | empty | error`。

### 3.3 文件变化事件（`FsChangeEvent`）

```ts
export type FsChangeType = 'created' | 'modified' | 'deleted' | 'renamed';
export type FsChangeSource = 'self' | 'external';
export interface FsChangeEvent {
  type: FsChangeType; path: string; oldPath?: string;
  kind: 'file' | 'directory'; source: FsChangeSource;
  seq: number;  // 主进程单调递增序号（去抖/排序用）
  at: number;    // epoch ms
}
```

- `seq` / `at` 由 `FileSystemService.pushEvent` 统一补（先 `++this.seq`，再发）；`source` 由 `isSelf(p)` 判定（见 §5.5）。

### 3.4 预检（`FileProbe` / `Eol`）

```ts
export type FileCategory = 'text' | 'binary' | 'large';
export interface FileProbe { size: number; category: FileCategory; encoding?: string; mimeType?: string; previewable: boolean; }
export type Eol = 'LF' | 'CRLF' | 'Mixed';
```

- `FilePreviewGate` 在打开非图片文件前先 `probeFile` 分流：`text → Monaco`；`binary → UnsupportedViewer`；`large → UnsupportedViewer(文件过大)`；`error → UnsupportedViewer(打开失败)`。

### 3.5 Git 状态（`GitStatusSnapshot`）

```ts
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'C' | 'R' | 'I';
//  M modified | A added | D deleted | U untracked(??) | C conflicted(UU/AA/DD)
//  R renamed(--no-renames 下不出现，保留) | I ignored(!!，.gitignore 灰度)
export interface GitStatusEntry { path: string; code: GitStatusCode; }
export interface GitStatusSnapshot { enabled: boolean; entries: GitStatusEntry[]; at: number; }
```

- `enabled: false` 表示非 git 仓库 / 无 git 可执行文件；渲染层拿到后清空两张装饰 map，不报错。

### 3.6 preload 白名单（`window.fileAPI` 全集）

| 方法 | 签名 | 主进程通道 |
| --- | --- | --- |
| readDirectory | `(path) => FsResult<FileNode[]>` | `fs:readDirectory` |
| readFile | `(path) => FsResult<{content, encoding, eol}>` | `fs:readFile` |
| writeFile | `(path, content, opts?) => FsResult<void>` | `fs:writeFile` |
| probeFile | `(path) => FsResult<FileProbe>` | `fs:probeFile` |
| readImage | `(path) => FsResult<{dataUrl}>` | `fs:readImage` |
| watchDir | `(path) => FsResult<{watchId}>` | `fs:watchDir` |
| unwatchDir | `(watchId) => FsResult<void>` | `fs:unwatchDir` |
| createFile | `(path) => FsResult<void>` | `fs:createFile` |
| createDirectory | `(path) => FsResult<void>` | `fs:createDirectory` |
| deleteEntry | `(path) => FsResult<void>` | `fs:deleteEntry` |
| renameEntry | `(oldPath, newPath) => FsResult<void>` | `fs:renameEntry` |
| openDirectoryDialog | `() => string \| null` | `dialog:openDirectory` |
| getPathForFile | `(file: File) => string` | —（`webUtils.getPathForFile`，Electron 44 替代已移除的 `File.path`） |
| dropOpen | `(paths: string[]) => FsResult<DropOpenResult>` | `fs:dropOpen` |
| copyText | `(text) => void` | `clipboard:writeText` |
| onFileChanged | `(cb) => () => void` | 订阅 `fs:changed`（返回退订函数） |
| readGitStatus | `(workspaceRoot) => GitStatusSnapshot` | `git:status` |
| onRequestClose | `(cb) => () => void` | 订阅 `app:requestClose` |
| confirmClose | `() => void` | `app:confirmClose`（send） |
| setNativeTheme | `(mode: 'dark'\|'light') => void` | `theme:apply`（send） |

> 渲染层 **绝不直接拼路径**：所有路径仍由主进程 containment 校验（写操作即便传嵌套/新路径，也只校验整个目标落在根内，再由 `fs.mkdir({recursive:true})` 兜底中间目录）。

### 3.7 主题系统与原生窗口外观（`theme.ts`）

- `ThemeMode = 'dark' | 'light'`；`PanelPosition = 'left' | 'right'`。
- `ThemeTokens`：背景 / 文字 / 边框 / 强调色 / 文件类型色 / Git 状态色 / 阴影 的集中令牌。
- `DARK_THEME` / `LIGHT_THEME` 两套 TRAE IDE 风格配色。
- `loadTheme()` / `saveTheme()` / `loadPanelPosition()` / `savePanelPosition()`：偏好持久化到 `localStorage`（键 `fileEditorTheme` / `fileEditorPanelPosition`），缺省跟随系统 `prefers-color-scheme`。
- 文件色映射：`EXT_COLOR_MAP`（`.ts`→`codeColor` 等）、`SPECIAL_FILE_COLOR_MAP`（`license`→`licenseColor`、`package.json`→`configColor`、`.gitignore`→`configColor` 等）、`getFileColorToken(name)`。
- 原生外观联动：`App` 切主题时调 `window.fileAPI.setNativeTheme(mode)` → 主进程 `ipcMain.on('theme:apply', (_, mode) => { nativeTheme.themeSource = mode; })`（`src/main/index.ts`），边框/标题栏随系统级 `themeSource` 变化；同时 `document.body` / `document.documentElement` 背景设为当前主题底色，避免原生边框与内容间露白。

---

## 4. 安全模型（P0）

### 4.1 威胁模型

前端是不可信渲染上下文（可加载任意文件内容、可触发任意 IPC）。威胁：路径穿越出工作区根、读取/写入工作区外文件、泄露真实绝对路径。

### 4.2 工作区根 containment（`assertWithinRoot` / `validateRootCandidate` / `resolveExistingAncestor`）

- 每次磁盘操作前先 `assertWithinRoot(target)`：
  1. `resolvedRoot = fs.realpath(workspaceRoot)`；
  2. 目标存在 → `real = fs.realpath(candidate)`；目标不存在（新建/重命名新路径）→ 向上递归 `resolveExistingAncestor(candidate)` 找最近存在的祖先目录再拼回文件名；
  3. `rel = path.relative(resolvedRoot, real)`；若 `rel.startsWith('..')` 或绝对路径 → 抛 `E_ESCAPE`（message 不含真实路径）。
- `validateRootCandidate(p)`：设根前的准入——必须是已存在目录且可读（`fs.stat` + 试 `readdir`）。
- `openDirectoryAt(candidate)` / `openDirectoryDialog()`：经 `validateRootCandidate` 后才 `this.workspaceRoot = path.resolve(candidate)`。
- `renameEntry` 双路径都校验；并前置自子树守卫：`newPath === oldPath || newPath.startsWith(oldPath + '/')` → `E_INVALID`（禁止移入自身/后代），该检查放 `E_EXIST` 之前以返回更准确错误。

### 4.3 路径比较归一化（`normalizePathForCompare`）

仅用于比较，**绝不用于寻址**：`path.normalize` → macOS 上 `NFC` 归一化（中文 NFD/NFC 坑）→ Windows 上 `toLowerCase()`（大小写不敏感 + 盘符）。用于 `selfWriteTracker` / `readSnapshot` / `dropOpen` 的 `isInside` 判定。

### 4.4 校验失败的用户侧表现

- 渲染层 `useFileAPI` 把 `FsResult.ok:false` 转成 `FsError` 抛出，调用方按 `code` 分支提示（如 `E_ESCAPE` 显示「路径超出工作区」、`E_EXIST` 显示「已存在」）。`FsError.message` 不含真实绝对路径。
- `TransportError`：IPC 通信层失败（`ipcRenderer.invoke` reject，即「连不上主进程」），与领域错误分开提示。

---

## 5. 文件系统服务（`FileSystemService`）

### 5.1 懒加载目录树（`readDirectory`）

- `assertWithinRoot` → `fs.stat` 校验目录 → `fs.readdir(dirPath, { withFileTypes: true })` → 映射为 `FileNode[]`（目录 `loadState:'unloaded'`）。
- **不再过滤 `.` 开头的隐藏文件/文件夹**（与 TRAE IDE 行为一致；隐藏项由 Git 状态之外的渲染层正常展示）。
- 排序：目录优先，目录/文件内部按 `localeCompare`（实际代码用 `a.name.localeCompare(b.name)`，纯字典序，不区分大小写）。

### 5.2 写操作（嵌套创建 / rename 双路径 / 自子树守卫）

- `createFile(path)`：`assertWithinRoot` → 已存在则 `E_EXIST` → `fs.mkdir(parentDir, {recursive:true})` 兜底中间目录 → 写空文件 → `markSelf`。**支持嵌套路径**（`sub/dir/foo.ts` 中间目录缺失自动创建）。
- `createDirectory(path)`：`fs.mkdir(path, {recursive:true})` → `markSelf`。
- `deleteEntry(path)`：`fs.rm(path, {recursive:true, force:false})` → `markSelf` + 清 `readSnapshot`。
- `writeFile(path, content, {force})`：containment → 若 `readSnapshot` 有记录且 `!force` 且 `mtimeMs/size` 变化 → `E_CONFLICT`（乐观并发防御，见 §7.3）→ 写盘 → 回写 `readSnapshot` + `markSelf`。（渲染层所有保存入口传 `force:true`，故 UI 路径不触发 `E_CONFLICT`。）
- `renameEntry(old, new)`：双路径 containment → 已存在 `E_EXIST` → 自子树守卫 → `fs.rename` → `markSelf` + 迁移 `readSnapshot` key。

### 5.3 目录监听：watchId 契约

- `watchDir(dirPath)`：containment → 生成 `watchId = 'w_' + (++watchSeq)` → `chokidar.watch(dirPath, {...})` → 存 `watchers` 并返 `{ watchId }`。
- `unwatchDir(watchId)`：取 `dispose()` 并删条目。
- 函数无法跨 IPC，故渲染层只持 `watchId`，主进程内 `watchDirectory` 真正建 watcher（见 §2.1）。

### 5.4 监听面同步（懒加载的必然推论）

- 展开目录 → `watchDir`；收起 / 删除 → `unwatchDir`。渲染层 `watchMapRef`（`dirPath → watchId`）管理生命周期；切换工作区 / 卸载全部退订（见 `App.tsx` 的 `openFolderAt` 与两个 cleanup effect）。
- 目录被删（self/external）时回收其子树全部 `watchMap` 条目，防 watcher 泄漏。

### 5.5 自写识别器（`selfWriteTracker`，事件源判定）

- `markSelf(paths)` 写入 `{归一化路径: Date.now()}`；`isSelf(p)` 判断 `now - ts <= SELF_WRITE_TTL`（1000ms）。
- 主进程写操作产生的事件标 `source:'self'`（渲染层收到只局部刷新，不弹窗）；外部 / git / 其他程序改动标 `source:'external'`（走 §8 矩阵）。
- **外部 rename 合成**：`unlink` 记入 `deleteBuffer`（`dir|name → {name, at}`，TTL 200ms），同目录同名的 `add` 在窗口内配对 → 发 `type:'renamed'`（含 `oldPath`）；否则发 `created`/`deleted`。

### 5.6 忽略规则与监听参数（chokidar 4）

```ts
chokidar.watch(dirPath, {
  depth: 0,                                  // 只监听本目录单层（§5.4）
  ignoreInitial: true,
  ignored: /(^|[/\\])(node_modules|\.git)([/\\]|$)/,  // 忽略 node_modules/.git
});
```

- macOS 上 chokidar 4 始终使用 FSEvents。单层 + 忽略规则保证监听面小、开销低。

---

## 6. 文件内容管线（预检 → 分流 → 解码/预览）

### 6.1 `probeFile` 预检流程（顺序不可调换：containment 永远是第一步）

1. `assertWithinRoot`（步骤 0）。
2. `fs.stat`：目录 → `E_ISDIR`；`size > maxFileSize`(默认 50MB) → `{category:'large', previewable:false}`。
3. 读前 8192 字节：有 BOM → `utf-8/utf-16le/utf-16be`；否则扫 NUL 字节 → `binary`（按魔数 `detectMime`：`image/*`、`application/octet-stream`）；无 NUL → `text, encoding:'utf-8'`。
4. **只认 BOM**：无 BOM 一律按 UTF-8，不猜测多字节编码（避免 jschardet 误判乱码）。编码判定后剥离 BOM 字符 `U+FEFF`。

### 6.2 `readFile` 链路

`assertWithinRoot` → `probeFile`（透传 `E_ESCAPE/E_NOENT/E_ISDIR`；`large → E_TOOBIG`；`binary → E_UNSUPPORTED`）→ 读字节 → 解码（UTF-8 直接 `toString`；BOM 明确的 UTF-16 走 `iconv.decode`，失败兜底 UTF-8）→ 去 BOM → `detectEol` → 写 `readSnapshot` → 返 `{content, encoding, eol}`。

### 6.3 换行符（EOL）数据链闭环

- `detectEol`：含 CRLF+LF → `Mixed`；仅 CRLF → `CRLF`；否则 `LF`。
- `CodeEditor` 加载时立即 `model.setEOL`（CRLF→`EndOfLineSequence.CRLF`，否则 LF），保存直接写 `model.getValue()`（model 已按选定 EOL 归一化，写盘不再转换）。
- 编码 + 换行符经 `onMeta` 上报底部状态栏。

### 6.4 底部状态栏（编码 · 换行符 + 保存反馈）

- 左：当前文件路径 / 工作区；中：`saveFeedback`（「保存成功 / 自动保存成功」，2.5s 自动消失）；右：`编码 · 换行符`（图片文件无条件不显示，避免残留上一个文本文件的脏 meta）。

### 6.5 图片预览数据链（`readImage`）

- 不依赖 `probeFile` 的 `category`：图片可能先被 probe 判为 `text`（SVG）或未知二进制（BMP/ICO 无魔数分支），此处按扩展名白名单 + 内容魔数 `detectImageMime` 复核。
- 流程：`assertWithinRoot` → `fs.stat`（非文件 `E_ISDIR`；`> IMAGE_MAX_SIZE`(20MB) `E_TOOBIG`）→ 读前 64 字节魔数/扩展名判定 → 读全量 → `base64` → 返 `{ dataUrl: 'data:<mime>;base64,...' }`。

### 6.6 预览范围（支持 / 不支持）

| 类别 | 路由 | 组件 |
| --- | --- | --- |
| 文本（text） | Monaco 编辑器 | `CodeEditor` |
| 图片（png/jpg/gif/webp/svg/bmp/ico） | `<img>` base64 | `ImageViewer` |
| 二进制 / 过大 / 读失败 | 友好提示页 | `UnsupportedViewer` |

> 图片判定由 `App.isImage(activePath)`（扩展名正则）先路由到 `ImageViewer`；其余非图片文本经 `FilePreviewGate.probeFile` 二次判定。

---

## 7. 编辑与保存

### 7.1 Monaco 集成 + 离线

- `monacoSetup.ts`：本地 `monaco-editor` + 5 类 worker（editor/json/css/html/ts）→ `self.MonacoEnvironment.getWorker` → `loader.config({ monaco })`，完全离线。
- `CodeEditor` 自定义主题 `trae-dark`（base `vs-dark`）/ `trae-light`（base `vs`），仅覆盖 `editor.background` 等配色与 app 主题对齐。初始化一次；`themeMode` 变化经 `ed.updateOptions({ theme })` 同步（修复切主题后浏览区仍为白底）。
- 切换文件：`key={filePath}` 重挂载换 model，不直改受控 value；`reqId` latest-guard 丢弃过期 `readFile` 响应（防 `filePath` 快速切换卡「读取中…」）。

### 7.2 modelRegistry（按 filePath 复用 model）

- `getOrCreateModel(monaco, filePath, content, lang)`：`uri = file://<filePath>`，同 uri 复用已有 model（保留未保存编辑），切换标签只 `setModel` 不销毁。
- `disposeModel(filePath)`：关闭标签 / 重命名 / 删除时调用，释放 model + 清 `modelMeta`。
- `getModel(filePath)`：关闭保存 / 自动保存取各 dirty tab 最新内容（非活动 tab 的 model 仍保留）。
- `modelMeta`：随 model 维护 `{encoding, eol}`，复用分支不读盘时补报状态栏（否则状态栏卡「读取中…」）。

### 7.3 保存链路（用户主动覆盖 + API 层乐观并发防御）

- 渲染层所有保存入口（Cmd+S / 保存按钮 / 关闭保存 / 自动保存）统一 `writeFile(path, content, {force:true})`——保存 = 用户主动覆盖写盘，**不拦截外部改动**。
- `E_CONFLICT` 实际不在 UI 路径触发（防御仅对主进程未来非 UI 调用方生效）；外部改动的可见性由 App 非阻塞提示条承担（§8.2）。
- Cmd/Ctrl+S 在 `CodeEditor` 内 `addCommand` 绑定 `saveRef.current()`；工具栏「保存」显式入口走 `saveActive`。

### 7.4 自动保存 / 关闭确认

- 设置面板（`SettingsModal`）经 `settings.ts` localStorage 持久化 `AutoSaveSettings`（默认关闭、间隔 30s，下限 1s 防误配）。启用时 `setInterval` 写回所有 dirty tab，确有落盘才提示「自动保存成功」。
- 关闭客户端：`mainWindow` 的 `close` 事件 `preventDefault` → 经 `app:requestClose` 问渲染层 → 有 dirty 弹三选框（保存/不保存/取消）→ 决策后 `confirmClose` → `app:confirmClose` 置 `allowClose` 并 `destroy()`。窗口全部关闭 → `app.quit()`。

---

## 8. 文件变化事件与冲突处理

### 8.1 事件源判定（`self` vs `external`）

- `FileSystemService` 在发事件时由 `isSelf(p)` 打 `source`；渲染层 `App` 订阅 `onFileChanged` 后按源分流。

### 8.2 冲突矩阵（以 `App.tsx` 事件订阅实际逻辑为准）

| 场景 | 处理 |
| --- | --- |
| `external` 修改 + 该文件 **dirty**（已编辑未保存） | 非阻塞提示条（`externalNote`）+ 双按钮：①重新加载外部版本（先二次确认「将丢弃未保存改动」再 `reloadFile`）②保留当前版本（关提示，不写盘） |
| `external` 修改 + 该文件 **已保存** | 自动 `reloadFile`（重载外部最新），并 `refreshGitStatus` |
| `external` 修改 + 文件未打开 | `scheduleRefreshNode(parentOf(path))` 局部刷新父目录（保留展开态）|
| `self` / 未打开 | `scheduleRefreshNode` 局部刷新（rename 双事件经 150ms 去重合并）|
| 任意文件改动后 | `void refreshGitStatus()`（主进程侧节流）|

> 任何保存入口仍直接 force 覆盖写盘；提示条只「告知 + 授权决策」，不裁决保存。

### 8.3 `renamed` / `deleted` 边界

- `renamed`：`App.applyRename` 对 tab 路径做精确替换（`t.path === oldPath`）与前缀替换（`t.path.startsWith(oldPath + '/')`，移动文件夹时其下已打开文件 tab 整体迁移）；释放旧路径 model，活动 tab 切到新路径并 `reloadSignal`。
- `deleted`（目录）：回收子树全部 watch；若删的是已打开文件所在目录，关闭相关 tab。

### 8.4 去抖 + in-flight 合并

- `scheduleRefreshNode(dir, 150ms)`：同父目录连续事件合并为一次刷新（防 FSEvents 批量事件卡顿）。
- `reloadTree` in-flight 合并：`reloadInFlightRef` 保证并发整树重载只跑一次（保留展开态：DFS 先序收集 `expandedPaths`，重载后逐级补载子节点）。
- `refreshNodeNow(dir)`：操作成功后立即确定性刷新并取消该目录待执行的合并刷新（避免紧跟事件再刷一遍）。

---

## 9. Git 状态高亮（可选增强，默认开启）

### 9.1 探测 / 采集（`GitStatusService`）

- 探测：`git rev-parse --show-toplevel`（cwd = workspaceRoot）；失败 → `disabledForSession = true`（本次会话关闭功能）。
- 采集：`git status --porcelain=v1 -uall --ignored --no-renames`（porcelain 路径相对 cwd = workspaceRoot），经 `execFile`（禁 shell:true 防路径注入）。
- **`maxBuffer: 64 * 1024 * 1024`**：含 node_modules 的仓库在 `-uall --ignored` 下 porcelain 输出常超默认 1MB，否则抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 导致采集失败、文件树全绿（历史 bug）。

### 9.2 节流 + in-flight + 降级

- `THROTTLE_MS = 2000`（窗口内直接返缓存）；并发请求合并为同一 in-flight。
- `TOPLEVEL_TIMEOUT_MS = 3000` / `STATUS_TIMEOUT_MS = 5000`。
- 超时/失败 → 沿用旧缓存（不阻塞文件树）；非仓库 → `{enabled:false}`；仅保留落在 workspaceRoot 内的条目（过滤仓库外层）。

### 9.3 状态码映射（`mapCode`）

| porcelain | code |
| --- | --- |
| `??` | `U`（untracked） |
| `!!` | `I`（ignored） |
| `DD`/`AA`/含 `U` | `C`（conflicted） |
| 含 `D` | `D` |
| 含 `M` | `M` |
| 含 `A` | `A` |
| 含 `R` | `R` |
| 其他 | `null`（忽略） |

### 9.4 目录聚合优先级

- `GIT_PRIORITY = { C:5, D:4, M:3, A:2, U:1, R:3, I:0 }`；`betterGit(a,b)` 取高优先级。
- `App.refreshGitStatus`：文件精确映射 `gitFileMap`；目录从下往上逐级 `betterGit` 聚合 `gitDirMap`（子项覆盖父项，干净目录最终落在 `gitDirMap.get(dir)` 缺失或 `I` 被改动项覆盖）。

### 9.5 渲染（灰名无点）

- `FileTree.renderRowContent`：`code === 'I'` → 整行 `color = textMuted`（图标 + 名称均灰，**不再用文件类型彩色**）。
- `FileTree.renderGitBadge`：`code` 存在且非 `I` → 右侧彩色徽标（M/A/U/D/C/R）；`I` → 返回 `null`（无绿点 / 无徽标）；目录无 git 变更且非 `I` → 右侧绿色小圆点（`dotClean`）。

---

## 10. 主题系统

### 10.1 ThemeTokens + 双主题（`theme.ts`）

- 集中令牌覆盖背景 / 文字 / 边框 / 强调色 / 文件类型色 / Git 状态色 / 阴影；`DARK_THEME` / `LIGHT_THEME` 两套 TRAE 风格配色（如暗色 `bgApp:#1e1e1e`、亮色 `#ffffff`）。
- 文件类型色映射：`EXT_COLOR_MAP`（`.md`→`markdownColor`、`.ts/.tsx/.js`→`codeColor`、`.json/.yml`→`configColor`、图片→`imageColor` 等）+ `SPECIAL_FILE_COLOR_MAP`（`license`→`licenseColor`、`package.json`/`.gitignore`→`configColor`、`readme`→`markdownColor` 等）。

### 10.2 createStyles + 组件内联（`styles.ts`）

- `createStyles(tokens): Record<string, CSSProperties>` 返回当前主题下全部样式；组件用 `const s = createStyles(tokens)` 取用，避免引入 CSS 框架与全局变量漂移。
- 向后兼容默认 `styles = createStyles(LIGHT_THEME)`（App 初始渲染立即被主题覆盖）。

### 10.3 原生窗口同步

- `App` 切主题 effect：`window.fileAPI.setNativeTheme(themeMode)` → 主进程 `nativeTheme.themeSource = mode`（`src/main/index.ts`）；同时设 `document.body/html` 背景为 `tokens.bgApp`，避免原生边框与内容间露白。

### 10.4 持久化

- `localStorage`：`fileEditorTheme`（dark/light，缺省跟随系统）、`fileEditorPanelPosition`（left/right）、`fileEditorSettings`（自动保存）、`fileEditorSidebarWidth`（分栏宽度）。

---

## 11. 渲染层交互

### 11.1 文件树（`FileTree`）

- TRAE IDE 风格：分区标题栏（「文件」+ 可折叠）+ 工具栏（新建文件/文件夹/刷新/全部折叠）。
- 文件类型图标 + 颜色编码名称（SVG inline，按扩展名/特殊文件名选图标）；目录展开箭头 + 文件夹图标。
- **子目录缩进引导线**：根层 `paddingLeft:4`；子层 `marginLeft:9 + paddingLeft:11 + borderLeft 1px`（明确层级归属）。
- **Git 徽标靠右**（M/A/U/D/C/R）；忽略项灰名无点。
- 右键上下文菜单：空白右键 → 新建于工作区根；节点右键 → 新建/重命名/删除/复制路径。
- **树内拖拽移动**（§11.1dnd）：行 `draggable`，`application/x-file-editor-path` MIME；拖到目录行 → `onMoveDrop(source, targetDir)`；拖到面板空白 → `onMoveToRoot(source)`（移到工作区根）；自子树/自身前置快速判断省去必然失败的 IPC。

### 11.2 面板置换 + 可拖拽分栏

- `panelPosition`（`left`/`right`）：`App` 在 `panelPosition==='left'` 时「文件树 → 分隔条 → 编辑区」，`right` 时反向；按钮 SVG 随状态切换。
- **分隔条拖拽方向镜像**：`onSplitterDown` 用 `panelPositionRef`（ref 读最新值，避免闭包过期）；`panelPosition==='right'` 时 `width = window.innerWidth - clientX`（向左拖 = 右侧文件树变大）。约束：最小 160px、编辑区至少留 260px；结束态 `saveSidebarWidth` 持久化。
- 渲染层无 `node:path`，用轻量 `joinPath(a,b)` / `parentOf` / `baseName`（posix 优先，兼容 windows 反斜杠）。

### 11.3 多标签页 + 批量关闭

- `openTabs: OpenTab[]`（`{path, isDirty}`）；打开文件新增 tab + 设 `activePath` + 同步 `selectedDir` 到该文件所在目录（点上级「＋」即建同目录）。
- 标签栏右端 `▾` 菜单 / tab 右键菜单：`关闭` / `关闭左侧全部` / `关闭右侧全部` / `关闭其他` / `关闭全部`（`buildTabMenuItems`，按锚点位置 disabled）。
- 关闭标签 / 批量关闭：`disposeModel` + 从 `openTabs` 移除；若含活动 tab 切到剩余最后一个并清 `activeMeta`。

### 11.4 拖拽打开（`dropOpen`）

- `App` 在 `window` capture 阶段挂 `dragover/dragleave/drop`，仅拦截含 `Files` 类型的拖拽（文本/HTML 放行给编辑器）；`getPathForFile(file)` 取绝对路径 → `dropOpen(paths)`。
- 主进程 `dropOpen`：拖入目录 → 第一个合法目录为新工作区根；拖入文件 → 在根内则打开，否则自动把工作区根切到其父目录；返回 `{root, files}` 打开指令。渲染层按指令 `openFolderAt(root)` + 逐个 `openFile(files)`。
- 拖入时全局遮罩（`dropOverlay`）提示「松开以打开」。

### 11.5 模态框替代原生 prompt/confirm

- 新建/重命名走 `InputModal`（支持嵌套路径，如 `src/utils/foo.ts`）；删除走 `ConfirmModal`；关闭确认走 `CloseConfirmModal`；设置走 `SettingsModal`。全部 `theme` 感知，替代被禁用的 `window.prompt/confirm`（Electron 陷阱）。

### 11.6 复制路径

- 右键「复制路径」→ `window.fileAPI.copyText(node.path)` → 主进程 `clipboard.writeText`（sandbox 下 `navigator.clipboard` 在 `file://` 不可靠，统一经 IPC）。

---

## 12. 性能设计

### 12.1 懒加载与监听面（结构性前提）

- 文件树只加载一层（`depth:0` chokidar），展开才向下加载 + watch；监听面随展开态增长，折叠/删除回收。

### 12.2 事件驱动刷新去抖（150ms）

- `scheduleRefreshNode` 同父目录连续事件合并为一次刷新，避免 FSEvents 批量事件 ×N 次 `readDirectory` + 整树重建。

### 12.3 整树重载 in-flight 合并

- `reloadTree` 用 `reloadInFlightRef` 合并并发整树重载；保留展开态（DFS 先序收集 + 逐级补载）。

### 12.4 展开态恢复

- `doReloadTree` 刷新前收集 `expandedPaths`（父先于子），重载后逐级恢复子节点，避免整树塌成根层。

### 12.5 chokidar 忽略规则

- `ignored: /(^|[/\\])(node_modules|\.git)([/\\]|$)/` + `depth:0` + `ignoreInitial`，监听面最小、开销最低。

---

## 13. 开发与运营

### 13.1 脚本矩阵（对照 `package.json`）

| 脚本 | 作用 |
| --- | --- |
| `dev` / `start` / `stop` / `status` | electron-vite dev / dev-daemon 启停查 |
| `build` / `preview` | electron-vite 构建 / 预览 |
| `dist` / `dist:mac:*` / `dist:win:*` / `dist:linux:*` | electron-builder 三端分发（`scripts/dist.mjs`） |
| `clean` / `typecheck` / `lint` / `check` | 清理 / `tsc --noEmit` / eslint / `tsc --noEmit && eslint` |
| `e2e` / `screenshots` | CDP 端到端 / 自包含截图生成 |

### 13.2 dev-daemon（`scripts/dev-daemon.mjs`）

- 经 `node scripts/dev-daemon.mjs start` 托管 electron-vite，提供 start/stop/status 子命令（dev 期 `sandbox:false` 绕开 Mac 签名限制）。

### 13.3 验收门禁（check gate）

- 交付前 `pnpm check`（`tsc --noEmit` + `eslint .`）必须全绿；E2E 钩子类修改须验证 `EIF_AUTO_DIR` 残留 = 0。
- 代码/模板变更须联动更新本文档（权威）与 `ci-release-pipeline.md`（发布/签名权威）。

### 13.4 CDP 端到端（`scripts/e2e/`）

- 零 npm 依赖，复用 CDP 客户端 + `EIF_AUTO_DIR` 钩子机制，生成 `docs/images/` 截图（`scripts/screenshots.mjs`）。

---

## 14. 打包与发布

- electron-builder 三端配置见 `electron-builder.yml`；命令矩阵见 `scripts/dist.mjs`；CI 四层发布链路见 `docs/ci-release-pipeline.md`（本文不重复，以该文为权威）。
- 注意：`win.signingHashAlgorithms` 须放 `win.signtoolOptions` 子对象（26.x 顶层写法被 schema 打回）。

---

## 15. 验收门禁（要点回顾）

1. `pnpm check` 全绿（tsc + eslint）。
2. 打开含 node_modules / .gitignore 项的 git 仓库：node_modules 等忽略项显示为灰色（无绿点），且不因 `maxBuffer` 溢出导致全树变绿。
3. 切换暗/亮主题：编辑区（Monaco）、图片预览、提示页背景同步；原生窗口边框/标题栏随 `nativeTheme.themeSource` 变化。
4. 面板置换后拖拽分隔条方向正确（右侧文件树向左拖变大）。
5. 新建文件/文件夹落在选中目录（支持嵌套多级路径）；隐藏文件可见；子目录缩进引导线清晰。
6. 外部改动：dirty 文件弹非阻塞提示条、已保存文件自动重载、未打开文件局部刷新，展开态不丢失。
7. 关闭客户端：有未保存内容弹三选框，决策后真正退出。

---

## 16. 已知取舍 / backlog

- **主动不做**：崩溃恢复（用自动定时保存 + 多标签 model 复用替代）；目录「移到自身/后代」由主进程 `E_INVALID` 拦截；跨平台仅 macOS MVP。
- **健壮性**：`writeFile` 乐观并发 `E_CONFLICT` 当前 UI 路径不触发（全部 `force`），API 层防御保留给未来非 UI 调用方；Windows 路径大小写不敏感已归一化比较但仍按 posix 假设主流程。
- **待补**：树内拖拽移动的批量/跨根边界动画；大仓 git 状态采集的流式/增量优化（当前整仓 porcelain 单次采集，依赖 2s 节流 + in-flight 合并）。
