// src/renderer/hooks/useFileAPI.ts
//
// 对 window.fileAPI 的薄封装：统一处理 transport error（ipcRenderer.invoke reject，
// 即“连不上主进程”）与领域错误（FsResult.ok:false）。调用方拿到的是：
//   - 成功：直接返回 data
//   - 失败：抛出 FsError（领域错误，可按 code 分支提示）
//           或 TransportError（进程通信层失败，UI 提示不同）

import { useCallback, useMemo } from 'react';
import type { FileNode, FileProbe, FsResult, DropOpenResult } from '@shared/types/fs';
import type { GitStatusSnapshot } from '@shared/types/git';

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

async function invoke<T>(p: Promise<FsResult<T>>): Promise<T> {
  let res: FsResult<T>;
  try {
    res = await p;
  } catch (e) {
    throw new TransportError(`主进程通信失败：${(e as Error).message}`);
  }
  if (res.ok) return res.data;
  throw res.error; // 领域错误，调用方按 code 处理
}

export function useFileAPI() {
  const openDirectory = useCallback(async (): Promise<string | null> => {
    try {
      return await window.fileAPI.openDirectoryDialog();
    } catch (e) {
      throw new TransportError(`打开文件夹失败：${(e as Error).message}`);
    }
  }, []);

  const readDirectory = useCallback((p: string) => invoke(window.fileAPI.readDirectory(p)), []);
  const probeFile = useCallback((p: string) => invoke(window.fileAPI.probeFile(p)), []);
  const readImage = useCallback((p: string) => invoke(window.fileAPI.readImage(p)), []);
  const readFile = useCallback((p: string) => invoke(window.fileAPI.readFile(p)), []);
  const writeFile = useCallback(
    (p: string, content: string, opts?: { force?: boolean }) =>
      invoke(window.fileAPI.writeFile(p, content, opts)),
    [],
  );
  const watchDir = useCallback((p: string) => invoke(window.fileAPI.watchDir(p)), []);
  const unwatchDir = useCallback((id: string) => invoke(window.fileAPI.unwatchDir(id)), []);

  // §3.6b 拖拽打开：把系统拖入的文件/目录交给主进程判型与设根，返回打开指令
  const dropOpen = useCallback(
    (paths: string[]) => invoke(window.fileAPI.dropOpen(paths)) as Promise<DropOpenResult>,
    [],
  );
  // File → 绝对路径（Electron 44：webUtils.getPathForFile 替代已移除的 File.path）
  const getPathForFile = useCallback((file: File) => window.fileAPI.getPathForFile(file), []);

  // —— 文件树写操作（Step 5 / §3.1）——
  const createFile = useCallback((p: string) => invoke(window.fileAPI.createFile(p)), []);
  const createDirectory = useCallback((p: string) => invoke(window.fileAPI.createDirectory(p)), []);
  const deleteEntry = useCallback((p: string) => invoke(window.fileAPI.deleteEntry(p)), []);
  const renameEntry = useCallback(
    (oldPath: string, newPath: string) => invoke(window.fileAPI.renameEntry(oldPath, newPath)),
    [],
  );

  // 系统剪贴板（复制文件路径等）：直接透传，不经 FsResult 信封
  const copyText = useCallback((text: string) => window.fileAPI.copyText(text), []);

  // §15 Git 状态高亮：直接透传快照（非仓库时 enabled:false）
  const readGitStatus = useCallback(
    (workspaceRoot: string) => window.fileAPI.readGitStatus(workspaceRoot) as Promise<GitStatusSnapshot>,
    [],
  );

  // 关闭客户端拦截：主进程 close 时询问渲染层是否需提示保存
  const onRequestClose = useCallback((cb: () => void) => window.fileAPI.onRequestClose(cb), []);
  const confirmClose = useCallback(() => window.fileAPI.confirmClose(), []);

  // ⚠️ 必须用 useMemo 稳定化：各方法本身是 [] 依赖的 useCallback（稳定），但若裸返回
  // 对象字面量，api 引用会在每次渲染时变化。FilePreviewGate / CodeEditor 的 effect
  // 依赖数组含 api，引用变化会导致 effect 每次渲染重跑（曾在 effect 内同步 setState 的
  // 组件上触发 "Maximum update depth exceeded" 无限循环，冻结 UI——状态栏永久"读取中…"）。
  return useMemo(
    () => ({
      openDirectory,
      readDirectory,
      probeFile,
      readImage,
      readFile,
      writeFile,
      watchDir,
      unwatchDir,
      dropOpen,
      getPathForFile,
      createFile,
      createDirectory,
      deleteEntry,
      renameEntry,
      copyText,
      readGitStatus,
      onRequestClose,
      confirmClose,
    }),
    // 所有成员均为 [] 依赖的 useCallback，身份恒稳定；仅需在首次渲染构造一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}

export type { FileNode, FileProbe };
