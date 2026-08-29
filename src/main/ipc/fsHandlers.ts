// src/main/ipc/fsHandlers.ts
//
// 注册所有 ipcMain.handle（见设计文档 §3.2 的 channel 名单）。
// §9.3：所有 handler 在把 FsResult 发往渲染层前，统一用 toClientError 剥除 path，
// 绝不让真实绝对路径泄露到渲染进程（E_ESCAPE / E_NOENT 等的 path 仅主进程本地日志用）。

import { ipcMain } from 'electron';
import type { FileSystemService } from '../services/FileSystemService';
import type { FsError, FsResult } from '@shared/types/fs';

function toClientError(error: FsError): FsError {
  // 显式丢弃 path 字段
  const { path: _omit, ...rest } = error;
  return rest;
}

export function registerFsHandlers(service: FileSystemService): void {
  const wrap = async <T>(fn: () => Promise<FsResult<T>>): Promise<FsResult<T>> => {
    const r = await fn();
    return r.ok ? r : { ok: false, error: toClientError(r.error) };
  };

  ipcMain.handle('fs:readDirectory', (_e, p: string) => wrap(() => service.readDirectory(p)));
  ipcMain.handle('fs:readFile', (_e, p: string) => wrap(() => service.readFile(p)));
  ipcMain.handle('fs:writeFile', (_e, p: string, c: string, opts?: { force?: boolean }) =>
    wrap(() => service.writeFile(p, c, opts)),
  );
  ipcMain.handle('fs:probeFile', (_e, p: string) => wrap(() => service.probeFile(p)));
  ipcMain.handle('fs:readImage', (_e, p: string) => wrap(() => service.readImage(p))); // §13.6
  ipcMain.handle('fs:createFile', (_e, p: string) => wrap(() => service.createFile(p)));
  ipcMain.handle('fs:createDirectory', (_e, p: string) => wrap(() => service.createDirectory(p)));
  ipcMain.handle('fs:deleteEntry', (_e, p: string) => wrap(() => service.deleteEntry(p)));
  ipcMain.handle('fs:renameEntry', (_e, o: string, n: string) => wrap(() => service.renameEntry(o, n)));
  ipcMain.handle('fs:watchDir', (_e, p: string) => wrap(() => service.watchDir(p)));
  ipcMain.handle('fs:unwatchDir', (_e, id: string) => wrap(() => service.unwatchDir(id)));

  // openDirectoryDialog 不经 FsResult 信封（见 §3.1 注释），也不做 containment（此时尚无 root）
  ipcMain.handle('dialog:openDirectory', () => service.openDirectoryDialog());

  // §3.6b 拖拽打开：传入拖入的绝对路径数组（渲染层经 webUtils.getPathForFile 提取，
  // 主进程统一判型/设根/按 containment 过滤），返回 { root, files } 打开指令
  ipcMain.handle('fs:dropOpen', (_e, paths: string[]) =>
    wrap(() => service.dropOpen(Array.isArray(paths) ? paths : [])),
  );
}
