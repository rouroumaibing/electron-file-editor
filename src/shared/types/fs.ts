// src/shared/types/fs.ts
//
// 所有契约类型的唯一真源（见设计文档 §3 / §6）。
// main 与 renderer 都通过 tsconfig paths 别名 `@shared` 引用本文件，
// 不复制、不漂移 —— 避免 main 侧出现两份不同类型的契约（见 §2.2 / §3 引言）。

export type FsErrorCode =
  | 'E_NOENT' // 路径不存在
  | 'E_PERM' // 权限不足（含 Mac 沙盒未授权）
  | 'E_EXIST' // 创建时路径已存在
  | 'E_ISDIR' // 期望文件但遇到目录
  | 'E_NOTDIR' // 期望目录但遇到文件
  | 'E_TOOBIG' // 文件超过阈值（默认 50MB，见 9.5）
  | 'E_ESCAPE' // 路径穿越工作区根目录（安全校验拦截，见 12）
  | 'E_UNSUPPORTED' // 二进制 / 不支持预览的文件类型（见 13）
  | 'E_CONFLICT' // 保存时发现文件已被外部改动（乐观并发冲突，见 9.7）
  | 'E_INVALID' // 非法操作参数（如把目录移入自身/自身子目录）
  | 'E_UNKNOWN';

// ⚠️ FsError.path 仅用于主进程本地日志。ipcMain.handle 的返回值会被结构化克隆
// 完整发往渲染进程，因此 handler 在 return 前必须调 toClientError 剥除 path
// （见 §3.1 的 toClientError 约定）。渲染层永远拿不到真实绝对路径。
export interface FsError {
  code: FsErrorCode;
  message: string;
  path?: string;
}

export type FsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FsError };

// —— 运行期事件（§3.3）——
export type FsChangeType = 'created' | 'modified' | 'deleted' | 'renamed';
export type FsChangeSource = 'self' | 'external';

export interface FsChangeEvent {
  type: FsChangeType;
  path: string; // 受影响条目的当前路径
  oldPath?: string; // 仅 type==='renamed' 时携带
  kind: 'file' | 'directory';
  source: FsChangeSource; // 'self'=本应用写操作触发；'external'=外部/git/其他程序
  seq: number; // 主进程单调递增序号，前端用于去抖与排序
  at: number; // 事件发生时间（ms epoch）
}

// —— 文件树节点状态机（§3.2）——
export type NodeLoadState = 'unloaded' | 'loading' | 'loaded' | 'empty' | 'error';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  // 仅 directory 使用，描述子节点加载状态（与 UI 的 expanded 解耦）
  loadState?: NodeLoadState;
  loadError?: string; // loadState==='error' 时的可读信息
  // UI 状态：用户是否已展开（不决定 loadState，只决定是否触发懒加载）
  expanded?: boolean;
}

// —— 预检（§6.1）——
export type FileCategory = 'text' | 'binary' | 'large';

export interface FileProbe {
  size: number;
  category: FileCategory; // 'text' | 'binary' | 'large'
  encoding?: string; // 仅 text：检测到的编码（默认 'utf-8'）
  mimeType?: string; // 仅 binary：如 'image/png'
  previewable: boolean; // 是否允许在 Monaco 中打开
}

// —— 换行符（§6.3）——
export type Eol = 'LF' | 'CRLF' | 'Mixed';

// —— 拖拽打开（dropOpen §3.6b）——
// 主进程统一判定拖入条目的类型并设置工作区根后，返回给渲染层的"打开指令"：
//   - root：本次拖入产生的新工作区根（拖入目录，或文件自动提升其父目录）；
//            null 表示沿用当前工作区（文件已在根内，无需切换）
//   - files：应在当前根内直接打开的文件（已在主进程按 containment 过滤）
export interface DropOpenResult {
  root: string | null;
  files: string[];
}
