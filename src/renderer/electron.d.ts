// src/renderer/electron.d.ts
import type { FsResult, FileNode, FileProbe, FsChangeEvent, Eol, DropOpenResult } from '@shared/types/fs';
import type { GitStatusSnapshot } from '@shared/types/git';

declare global {
  interface Window {
    fileAPI: {
      readDirectory: (path: string) => Promise<FsResult<FileNode[]>>;
      readFile: (path: string) => Promise<FsResult<{ content: string; encoding: string; eol: Eol }>>;
      writeFile: (path: string, content: string, opts?: { force?: boolean }) => Promise<FsResult<void>>;
      probeFile: (path: string) => Promise<FsResult<FileProbe>>;
      readImage: (path: string) => Promise<FsResult<{ dataUrl: string }>>; // §13.6 图片预览
      watchDir: (path: string) => Promise<FsResult<{ watchId: string }>>;
      unwatchDir: (watchId: string) => Promise<FsResult<void>>;
      createFile: (path: string) => Promise<FsResult<void>>;
      createDirectory: (path: string) => Promise<FsResult<void>>;
      deleteEntry: (path: string) => Promise<FsResult<void>>;
      renameEntry: (oldPath: string, newPath: string) => Promise<FsResult<void>>;
      openDirectoryDialog: () => Promise<string | null>;
      // §3.6b 拖拽打开：File → 绝对路径（Electron 44 替代已移除的 File.path）
      getPathForFile: (file: File) => string;
      dropOpen: (paths: string[]) => Promise<FsResult<DropOpenResult>>;
      copyText: (text: string) => Promise<void>; // 写入系统剪贴板（右键「复制文件路径」等）
      // 返回退订函数（§3.2 #6）
      onFileChanged: (cb: (e: FsChangeEvent) => void) => () => void;
      // §15 Git 状态高亮：传入 workspaceRoot，返回装饰快照
      readGitStatus: (workspaceRoot: string) => Promise<GitStatusSnapshot>;
      // 关闭客户端拦截：主进程 close 时询问渲染层是否需提示保存（返回退订函数）
      onRequestClose: (cb: () => void) => () => void;
      // 渲染层决策后放行真正关闭
      confirmClose: () => void;
    };
  }
}

export {};
