// src/main/ipc/gitHandlers.ts
//
// Git 状态 IPC（设计文档 §15）。复用 §9.3 的 FsResult 信封；
// 非仓库/无 git 不视为错误，返回 { enabled:false }（见 §15.1 / §15.4）。
// 注意：git 状态不含真实文件内容，无 path 泄露风险，故不经 toClientError 剥 path。

import { ipcMain } from 'electron';
import type { GitStatusService } from '../services/GitStatusService';

export function registerGitHandlers(service: GitStatusService): void {
  ipcMain.handle('git:status', (_e, workspaceRoot: string) => service.getStatus(workspaceRoot));
}
