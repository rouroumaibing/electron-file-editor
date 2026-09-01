// src/main/index.ts
//
// 应用入口：创建 BrowserWindow（隔离配置见 §3.2）、初始化 FileSystemService、
// 注册 IPC handlers、把 FsChangeEvent 推送回渲染层。
//
// electron-vite 在开发模式会把 renderer 的 Vite dev server 地址注入
// process.env.ELECTRON_RENDERER_URL；生产构建时该变量未设置，renderer
// 产物位于 out/renderer/index.html（无子目录，见 electron-vite 约定）。

import { app, BrowserWindow, clipboard, ipcMain, nativeTheme } from 'electron';
import * as path from 'node:path';

import { FileSystemService } from './services/FileSystemService';
import { registerFsHandlers } from './ipc/fsHandlers';
import { GitStatusService } from './services/GitStatusService';
import { registerGitHandlers } from './ipc/gitHandlers';
import type { FsChangeEvent } from '@shared/types/fs';

// 🚧 electron-vite 5.0.0 在开发模式启动 electron 子进程时，会把 renderer 的
// dev server 地址注入到 process.env.ELECTRON_RENDERER_URL（见 electron-vite
// dist: process.env.ELECTRON_RENDERER_URL = `${protocol}//${host}:${port}`）。
// 生产构建时该变量未设置 → undefined → 走 loadFile 分支。
// 注意：旧模板的 MAIN_WINDOW_VITE_DEV_SERVER_URL 在 2.3.0 起已不存在，不可用。
const ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
// electron-vite 在 dev 期会把 NODE_ENV_ELECTRON_VITE 设为 'development'（见其 dist）。
// 此标志用于区分 dev / 生产，dev 期临时放宽 sandbox（见下方 webPreferences）。
const isDev = process.env.NODE_ENV_ELECTRON_VITE === 'development';

let mainWindow: BrowserWindow | null = null;

const service = new FileSystemService({
  pushEvent: (event: FsChangeEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fs:changed', event);
    }
  },
});

// §15 Git 状态高亮（纯增量装饰数据源；非仓库时 enabled:false，零开销）
const gitService = new GitStatusService();

// 关闭客户端拦截标志：close 事件默认 preventDefault，待渲染层决策后由
// app:confirmClose 置位并真正销毁窗口，避免被拦截逻辑卡死（见下方 createWindow）。
let allowClose = false;

function createWindow(): void {
  allowClose = false; // 每个新窗口恢复关闭拦截（上次确认关闭后置位的 true 需复位）
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // 注意相对路径：main 输出到 out/main/，preload 输出到 out/preload/，renderer 到 out/renderer/
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, // 必须开启（§1 / §3.2）
      nodeIntegration: false, // 必须关闭
      // §3.2 要求 sandbox:true 以收紧渲染进程权限（安全）。但 macOS 的 App Sandbox
      // 要求 app 带 entitlements 签名才能初始化；dev 期跑的是 node_modules 里未签名、
      // 未打包的 electron 二进制，sandbox:true 在 Mac 上必报
      // "sandbox initialization failed: Operation not permitted"。故仅 dev 临时关闭，
      // 生产打包（electron-builder.yml 已配 entitlements.mac.plist）仍保持 true。
      sandbox: !isDev,
    },
  });

  // 关闭拦截：有未保存内容时经渲染层弹"保存/不保存/取消"；取消则 abort。
  // 注意 preventDefault 后窗口不会自动关，必须显式 destroy（allowClose 防递归）。
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow?.webContents.send('app:requestClose');
  });

  if (ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(ELECTRON_RENDERER_URL);
  } else {
    // 生产：renderer 产物在 out/renderer/index.html（无子目录）
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerFsHandlers(service);
  registerGitHandlers(gitService);
  // 系统剪贴板：渲染层经 fileAPI.copyText → 此 handler 写入（sandbox 下
  // navigator.clipboard 在 file:// 不可靠，见 §3.2 / §3.3）。
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text);
  });
  // 渲染层决策完成（保存/不保存），放行真正关闭
  ipcMain.on('app:confirmClose', () => {
    allowClose = true;
    mainWindow?.destroy();
  });
  createWindow();

  // §主题：渲染层切换暗/亮后，驱动原生窗口外观（边框 / 标题栏）同步变化。
  // 默认跟随系统；仅当应用显式切换时才覆盖（与渲染层 loadTheme 行为一致）。
  ipcMain.on('theme:apply', (_e, mode: 'dark' | 'light') => {
    nativeTheme.themeSource = mode;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 产品决策：查看/编辑工具，关闭窗口 = 整个应用退出（含 dev 期 electron-vite
// 进程链）。不走 macOS"关窗留 Dock"惯例——用户明确要求关窗后服务进程结束。
// 注意：关闭拦截走 app:confirmClose → destroy()（绕过 close 事件），
// 最后一个窗口销毁后同样触发本事件退出。
app.on('window-all-closed', () => {
  app.quit();
});
