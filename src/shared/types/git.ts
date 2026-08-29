// src/shared/types/git.ts
//
// Git 状态高亮（设计文档 §10.4）的契约类型，与 fs.ts 并列，经 @shared 别名共享。
// 不在 main/ 或 renderer/ 下定义，保持三目录物理隔离（见 §2.2 / §3 类型落点约定）。

export type GitStatusCode =
  | 'M' // modified（已跟踪、有改动）
  | 'A' // added（已加入暂存区）
  | 'D' // deleted（已删除）
  | 'U' // untracked（porcelain 的 ??，归一化便于单字母展示）
  | 'C' // conflicted / unmerged（porcelain 的 UU/AA/DD 等）
  | 'R'; // renamed（--no-renames 下不出现，保留给未来）

// path 为绝对路径（主进程已按 workspaceRoot / toplevel 重定位，见 §10.4）
export interface GitStatusEntry {
  path: string;
  code: GitStatusCode;
}

export interface GitStatusSnapshot {
  enabled: boolean; // 非 git 仓库 / 无 git 可执行文件时为 false
  entries: GitStatusEntry[];
  at: number; // 采集时间（ms epoch），渲染层据此判断是否需要更新装饰
}
