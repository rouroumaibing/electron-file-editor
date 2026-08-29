// src/preload/index.ts
//
// 渲染进程唯一能“看到”主进程能力的窗口（见设计文档 §3.6）。
// 必须用白名单方式暴露，禁止暴露整个 ipcRenderer。
// 注意：sandbox:true + contextIsolation:true 下，contextBridge 仍可用。

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FsChangeEvent, DropOpenResult } from '@shared/types/fs';

contextBridge.exposeInMainWorld('fileAPI', {
  readDirectory: (path: string) => ipcRenderer.invoke('fs:readDirectory', path),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string, opts?: { force?: boolean }) =>
    ipcRenderer.invoke('fs:writeFile', path, content, opts),
  probeFile: (path: string) => ipcRenderer.invoke('fs:probeFile', path),
  readImage: (path: string) => ipcRenderer.invoke('fs:readImage', path), // §6.5 图片预览

  // §3.6b 拖拽打开：系统拖入的文件/目录 → 绝对路径（Electron 44 中 File.path 已移除，
  // 官方替代为 webUtils.getPathForFile；contextBridge 传 File 对象是文档支持用法）
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  dropOpen: (paths: string[]) =>
    ipcRenderer.invoke('fs:dropOpen', paths) as Promise<{ ok: true; data: DropOpenResult } | { ok: false; error: import('@shared/types/fs').FsError }>,

  // 目录监听订阅/退订（watchId 契约，见 §5.3；事件仍走下面的 onFileChanged 推送）
  watchDir: (path: string) => ipcRenderer.invoke('fs:watchDir', path),
  unwatchDir: (watchId: string) => ipcRenderer.invoke('fs:unwatchDir', watchId),

  // —— 文件树写操作（Step 5 新建/删除/重命名/移动）——
  // 注意：渲染层绝不直接拼路径，所有路径仍由主进程 containment 校验（见 §4.2）。
  createFile: (path: string) => ipcRenderer.invoke('fs:createFile', path),
  createDirectory: (path: string) => ipcRenderer.invoke('fs:createDirectory', path),
  deleteEntry: (path: string) => ipcRenderer.invoke('fs:deleteEntry', path),
  renameEntry: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('fs:renameEntry', oldPath, newPath),

  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),

  // 系统剪贴板（复制文件路径等）：sandbox 下 navigator.clipboard 在 file:// 不可靠，
  // 统一经白名单 IPC 到主进程 clipboard.writeText（见 §3.6 / §10.1）。
  copyText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // 订阅文件变化事件；返回退订函数，组件卸载时务必调用，避免 ipcRenderer 监听器累积（见 §3.6）
  onFileChanged: (callback: (event: FsChangeEvent) => void) => {
    const wrapper = (_e: unknown, data: FsChangeEvent) => callback(data);
    ipcRenderer.on('fs:changed', wrapper);
    return () => ipcRenderer.removeListener('fs:changed', wrapper);
  },

  // §10.4 Git 状态高亮：返回工作区 git status 装饰数据（非仓库 enabled:false）
  readGitStatus: (workspaceRoot: string) => ipcRenderer.invoke('git:status', workspaceRoot),

  // 关闭客户端拦截：主进程在 close 时经 onRequestClose 询问渲染层是否需提示保存；
  // 渲染层决策后调 confirmClose 放行真正关闭（避免被 close 拦截逻辑卡死）。
  onRequestClose: (callback: () => void) => {
    const wrapper = () => callback();
    ipcRenderer.on('app:requestClose', wrapper);
    return () => ipcRenderer.removeListener('app:requestClose', wrapper);
  },
  confirmClose: () => ipcRenderer.send('app:confirmClose'),
});
