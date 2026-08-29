// src/renderer/App.tsx
//
// 顶层布局与状态：打开文件夹 -> 文件树（懒加载）-> 多标签编辑器。
// 订阅主进程推送的 FsChangeEvent，按 §8 矩阵处理外部改动：
//   - external 修改 + dirty -> 非阻塞提示条（保存恒 force 覆盖，不拦截保存；§7.3 改版）
//   - external 修改 + 已保存  -> 自动重载（§8.2）
//   - self / 未打开文件        -> 局部刷新树
//
// 本轮修复（对照用户本地验收反馈）：
//   - 选中态高亮（§3.3）：selectedPath 由 App 持有，FileTree 叠加 rowSelected
//   - 监听生命周期（§9.4）：打开工作区 watch 根、目录展开 watch/收起 unwatch、卸载全退订；
//     外部改动经 onFileChanged 后局部刷新变动的父目录（保住展开状态）
//   - 模态框替代原生 dialog（§3.3 Electron 陷阱）：新建/重命名/删除走 InputModal/ConfirmModal，
//     不再使用被禁用的 window.prompt/confirm
//   - 图片预览分支（§13.6）：activePath 命中图片扩展名时渲染 ImageViewer 而非 Monaco

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { FileNode, FsChangeEvent, Eol } from '@shared/types/fs';
import type { GitStatusCode } from '@shared/types/git';
import { useFileAPI } from './hooks/useFileAPI';
import { FileTree } from './components/FileTree';
import { CodeEditor } from './components/CodeEditor';
import type { CodeEditorHandle } from './components/CodeEditor';
import { ImageViewer } from './components/ImageViewer';
import { FilePreviewGate } from './components/FilePreviewGate';
import { InputModal } from './components/InputModal';
import { ConfirmModal } from './components/ConfirmModal';
import { CloseConfirmModal } from './components/CloseConfirmModal';
import { SettingsModal } from './components/SettingsModal';
import { disposeModel, getModel, getModelMeta } from './modelRegistry';
import { loadSettings, saveSettings, loadSidebarWidth, saveSidebarWidth } from './settings';
import type { AutoSaveSettings } from './settings';
import { styles } from './styles';

interface OpenTab {
  path: string;
  isDirty: boolean;
}

// tab 批量关闭菜单项（tab 栏右端 ▾ 按钮 / tab 右键菜单共用）
interface TabMenuItem {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

// tab 菜单状态：anchor 为菜单锚点 tab（null = 批量按钮菜单，锚点为活动 tab）
interface TabMenuState {
  x: number;
  y: number;
  anchor: string | null;
}

// 渲染进程无 node:path，用轻量 posix join（路径均由主进程按 posix 返回）
function joinPath(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

// 取事件路径的父目录；根层（无更浅层）返回 null，refreshNode(null) 退化为 reloadTree
function parentOf(p: string): string | null {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : null;
}

// 取路径末段文件名/目录名（posix 优先，兼容 windows 反斜杠）；拖拽打开的状态栏提示用
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// 图片预览路由（§13.6）：与主进程 detectMime / 扩展名白名单口径一致
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
function isImage(p: string): boolean {
  return IMAGE_EXT.test(p);
}

// —— §15 Git 状态高亮：目录聚合优先级（C > D > M > A > U；R 同 M）——
const GIT_PRIORITY: Record<GitStatusCode, number> = { C: 5, D: 4, M: 3, A: 2, U: 1, R: 3 };
function betterGit(a: GitStatusCode, b: GitStatusCode): GitStatusCode {
  return GIT_PRIORITY[a] >= GIT_PRIORITY[b] ? a : b;
}
// 取父目录（posix 优先，兼容 windows 反斜杠）；到文件系统根返回 null
function parentDirOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : null;
}

// 模态框状态（回调随 state 持有，不序列化）
type ModalState =
  | { kind: 'input'; title: string; initialValue: string; placeholder?: string; onConfirm: (value: string) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel?: string; onConfirm: () => void };

// 递归更新树中某个节点的字段（加载子节点 / 折叠展开 / 错误）
function updateNode(nodes: FileNode[], targetPath: string, patch: Partial<FileNode>): FileNode[] {
  return nodes.map((n) => {
    if (n.path === targetPath) return { ...n, ...patch };
    if (n.children) return { ...n, children: updateNode(n.children, targetPath, patch) };
    return n;
  });
}

export default function App() {
  const api = useFileAPI();
  // 解构出稳定方法（useFileAPI 内全部为 [] 依赖的 useCallback）：hooks 依赖里
  // 引用具体方法而非 api 对象，避免回调依赖每渲染新建的 api 身份导致反复重建/重订。
  const { writeFile, readGitStatus, confirmClose, onRequestClose } = api;
  const { readDirectory, unwatchDir } = api;

  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null); // §3.3 选中态
  // §8.2（改版）外部修改提示：external 修改 + dirty 时非阻塞提示（不拦截保存）。
  // 双按钮：重新加载外部版本（丢弃未保存改动） / 保留当前版本（确认继续编辑，提示消失）。
  const [externalNote, setExternalNote] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  // §7.3（改版 v2）底部"保存成功/自动保存成功"反馈：短暂显示后自动消失（nonce 用于重置计时）
  const [saveFeedback, setSaveFeedback] = useState<{ text: string; nonce: number } | null>(null);
  const showSaveFeedback = useCallback((text: string) => {
    setSaveFeedback({ text, nonce: Date.now() });
  }, []);
  // §7.3（改版 v2）：反馈 2.5s 自动消失；nonce 变化重置计时器
  useEffect(() => {
    if (!saveFeedback) return;
    const t = setTimeout(() => setSaveFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [saveFeedback]);
  const [reloadSignal, setReloadSignal] = useState<{ path: string; nonce: number } | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null); // §3.3 模态框替代 prompt/confirm
  // §14 关闭客户端提示保存：存在未保存文件时弹出的三选框（保存/不保存/取消）
  const [closeModal, setCloseModal] = useState<{ dirtyCount: number } | null>(null);
  // §14 设置面板开关（自动定时保存）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // §14 自动定时保存设置（仅渲染层 localStorage 持久化）
  const [settings, setSettings] = useState<AutoSaveSettings>(() => loadSettings());
  // §17 可拖拽分栏：侧栏宽度（默认 260，可自由左右拉伸；经 localStorage 跨会话记住）
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [isResizing, setIsResizing] = useState(false);
  const resizingRef = useRef(false);
  // §13 底部状态栏：当前活动文本文件的编码 + 换行符（CodeEditor 加载成功后上报）
  const [activeMeta, setActiveMeta] = useState<{ encoding: string; eol: Eol } | null>(null);
  // tab 批量关闭菜单（tab 右键 / 栏右端 ▾ 按钮）
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
  // §3.6b 拖拽打开：系统文件/文件夹拖入窗口时的高亮遮罩开关（Files 类型拖拽才置位）
  const [dragActive, setDragActive] = useState(false);
  // §3.6c 树内拖拽移动：当前拖拽的源节点路径（null = 无拖拽）与悬停的目标目录路径
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  // §3.6c 根落点悬停：树面板空白区域 = 工作区根（区别于 dragOverDir 的目录行落点）
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);

  // §17 拖拽分栏：在 sidebar 与 editorArea 之间的竖向分隔条上 mousedown 后，
  // 监听全局 mousemove 更新宽度，mouseup 结束（结束态经 localStorage 持久化）。
  // 约束：最小 160px、右侧至少留 260px。
  const onSplitterDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let latest = 0;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      latest = Math.min(Math.max(ev.clientX, 160), window.innerWidth - 260);
      setSidebarWidth(latest);
    };
    const onUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      if (latest > 0) saveSidebarWidth(latest);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);
  // §15 Git 状态高亮：文件精确映射 + 目录聚合映射（key 均为绝对路径）
  const [gitFileMap, setGitFileMap] = useState<Map<string, GitStatusCode>>(new Map());
  const [gitDirMap, setGitDirMap] = useState<Map<string, GitStatusCode>>(new Map());

  // 用 ref 持有最新值，供事件回调读取（避免闭包过期）
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  // §9.4 监听生命周期：dirPath -> watchId（展开 watch、收起 unwatch、卸载全退订）
  const watchMapRef = useRef<Map<string, string>>(new Map());
  // §14 会话内撤销/重做：持有活动编辑器命令式句柄（CodeEditor 按 activePath 重挂载，
  // ref 总指向当前活动编辑器）
  const editorRef = useRef<CodeEditorHandle>(null);

  // §10 防并发风暴：整树重载 in-flight 合并（rename 的 unlink+add 双事件 + 手动刷新
  // 会并发触发多次 reloadTree，每次都重跑 N+1 次串行 IPC 并重建整树 —— 合并为一次）
  const reloadInFlightRef = useRef<Promise<void> | null>(null);

  const doReloadTree = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) return;
    // 刷新前收集全部已展开目录（DFS 先序 = 父先于子），刷新后恢复展开态并逐级补载子节点，
    // 避免整树重载把会话内展开状态全部塌掉；已建立的 watch 不动（watchMap 生命周期不受影响）
    const expandedPaths: string[] = [];
    const collect = (ns: FileNode[]) =>
      ns.forEach((n) => {
        if (n.expanded) {
          expandedPaths.push(n.path);
          if (n.children) collect(n.children);
        }
      });
    collect(treeRef.current);
    try {
      const nodes = await readDirectory(root);
      setTree(nodes.map((n) => (expandedPaths.includes(n.path) ? { ...n, expanded: true } : n)));
      // 逐级恢复子节点（先序顺序保证 updateNode 能在已载入的父层里找到子目录）
      for (const dirPath of expandedPaths) {
        try {
          const children = await readDirectory(dirPath);
          setTree((prev) =>
            updateNode(prev, dirPath, {
              children,
              loadState: children.length ? 'loaded' : 'empty',
              expanded: true,
            }),
          );
        } catch {
          /* 展开目录可能已被删除，跳过并回收其残留监听（§9.4 生命周期） */
          const id = watchMapRef.current.get(dirPath);
          if (id) {
            void unwatchDir(id).catch(() => {});
            watchMapRef.current.delete(dirPath);
          }
        }
      }
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, [readDirectory, unwatchDir]);

  const reloadTree = useCallback((): Promise<void> => {
    if (reloadInFlightRef.current) return reloadInFlightRef.current;
    const p = doReloadTree().finally(() => {
      reloadInFlightRef.current = null;
    });
    reloadInFlightRef.current = p;
    return p;
  }, [doReloadTree]);

  // 事件驱动刷新去重（§10）：rename 的 unlink+add 双事件、FSEvents 批量事件在短窗口内
  // 合并为一次刷新，避免同一父目录被并发刷 N 次（readDirectory IPC + 整树重建 ×N = 卡顿）
  const refreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 立即刷新某个已展开目录的子节点（创建/删除/重命名等操作成功后调用，保证确定性反馈），
  // 并取消该目录尚未执行的合并刷新（避免紧跟事件又刷一遍）
  const refreshNodeNow = useCallback(
    async (dirPath: string | null) => {
      const key = dirPath ?? '__root__';
      const pending = refreshTimersRef.current.get(key);
      if (pending) {
        clearTimeout(pending);
        refreshTimersRef.current.delete(key);
      }
      // tree state 存的是「根目录的 children 数组」，root 本身不是树内节点——
      // 目标是工作区根时 updateNode 会静默无操作（根层删除/重命名/事件曾因此不刷新），退化为整树重载
      if (!dirPath || dirPath === workspaceRootRef.current) {
        await reloadTree();
        return;
      }
      try {
        const children = await readDirectory(dirPath);
        setTree((prev) =>
          updateNode(prev, dirPath, {
            children,
            loadState: children.length ? 'loaded' : 'empty',
            expanded: true,
          }),
        );
      } catch (e) {
        setStatus((e as Error).message);
      }
    },
    [readDirectory, reloadTree],
  );

  // 事件回调专用：150ms 窗口去重（同一父目录的连续事件只刷一次）
  const scheduleRefreshNode = useCallback(
    (dirPath: string | null) => {
      const key = dirPath ?? '__root__';
      const pending = refreshTimersRef.current.get(key);
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => {
        refreshTimersRef.current.delete(key);
        void refreshNodeNow(dirPath);
      }, 150);
      refreshTimersRef.current.set(key, timer);
    },
    [refreshNodeNow],
  );

  const reloadFile = useCallback((filePath: string) => {
    setReloadSignal({ path: filePath, nonce: Date.now() });
  }, []);

  // 新建（可能嵌套，如 "src/utils/foo.ts"）后：整树重载保底（保留已有展开态），
  // 再逐级展开到目标父目录，保证新建的中间目录与新条目立即可见（问题：只刷一层会"看不到"）
  const revealDirectory = useCallback(
    async (dirPath: string) => {
      const root = workspaceRootRef.current;
      if (!root) return;
      await reloadTree();
      if (!dirPath || dirPath === root) return; // 目标父目录就是根：reloadTree 已足够
      const rel = dirPath.slice(root.length).replace(/^\/+/, '');
      const parts = rel.split('/').filter(Boolean);
      let cur = root;
      for (const part of parts) {
        cur = joinPath(cur, part);
        try {
          const children = await readDirectory(cur);
          setTree((prev) =>
            updateNode(prev, cur, {
              children,
              loadState: children.length ? 'loaded' : 'empty',
              expanded: true,
            }),
          );
        } catch {
          break; // 目录可能刚被删除，停止展开
        }
      }
    },
    [readDirectory, reloadTree],
  );

  // §15 Git 状态高亮：拉取并重算（文件精确映射 + 目录向上聚合）
  const refreshGitStatus = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) return;
    try {
      const snap = await readGitStatus(root);
      if (!snap.enabled) {
        setGitFileMap(new Map());
        setGitDirMap(new Map());
        return;
      }
      const fm = new Map<string, GitStatusCode>();
      const dm = new Map<string, GitStatusCode>();
      for (const e of snap.entries) {
        fm.set(e.path, e.code);
        let d = parentDirOf(e.path);
        while (d) {
          const cur = dm.get(d);
          dm.set(d, cur ? betterGit(cur, e.code) : e.code);
          d = parentDirOf(d);
        }
      }
      setGitFileMap(fm);
      setGitDirMap(dm);
    } catch {
      /* 装饰失败不阻断主流程 */
    }
  }, [readGitStatus]);

  // §14 关闭客户端提示保存：经 onRequestClose 询问，有 dirty 则弹确认，否则直接 confirmClose。
  // 关闭保存 / 自动保存均复用 modelRegistry.getModel 取各 dirty tab 的最新内容写盘。

  // 打开工作区根（「打开文件夹」按钮与拖拽打开共用，§3.6b）：
  // 退订全部旧监听 → 清空会话态 → 读树 → watch 根 → 首次采集 git 状态
  const openFolderAt = useCallback(
    async (root: string) => {
      // 切换工作区：退订全部旧监听（§9.4 生命周期）
      watchMapRef.current.forEach((id) => {
        void unwatchDir(id).catch(() => {});
      });
      watchMapRef.current.clear();
      try {
        setWorkspaceRoot(root);
        setOpenTabs([]);
        setActivePath(null);
        setSelectedPath(null);
        setActiveMeta(null); // 切换工作区：清空编码信息
        setExternalNote(null); // 切换工作区：清空外部修改提示
        const nodes = await readDirectory(root);
        setTree(nodes);
        setStatus(`工作区：${root}`);
        // watch 根目录（§9.4 生命周期）
        try {
          const { watchId } = await api.watchDir(root);
          watchMapRef.current.set(root, watchId);
        } catch {
          /* watch 失败不阻断打开 */
        }
        void refreshGitStatus(); // §15 首次采集
      } catch (e) {
        setStatus((e as Error).message);
      }
    },
    [api, readDirectory, unwatchDir, refreshGitStatus],
  );

  const openFolder = useCallback(async () => {
    const root = await api.openDirectory();
    if (root) await openFolderAt(root);
  }, [api, openFolderAt]);

  const openFile = useCallback((filePath: string) => {
    setOpenTabs((prev) =>
      prev.some((t) => t.path === filePath) ? prev : [...prev, { path: filePath, isDirty: false }],
    );
    setActivePath(filePath);
    setSelectedPath(filePath); // §3.3 选中态
    // §13 状态栏 meta：已打开过的文件直接从注册表恢复（同步、不依赖 CodeEditor 重跑）。
    // 不能无脑 setActiveMeta(null)——重复点击同一文件时 activePath 值不变（React bail out
    // 不重渲染，FilePreviewGate/CodeEditor 均不重挂载、加载 effect 不重跑），清空后无人
    // 补报，状态栏永久"读取中…"（与文件内容无关，txt/md 全中）。首次打开（无 meta）才
    // 清空，等 CodeEditor 读盘成功后经 onMeta 上报。
    const meta = getModelMeta(filePath);
    setActiveMeta(meta ? { ...meta } : null);
  }, []);

  // §3.6b 拖拽打开：把系统拖入的文件/文件夹交给主进程判型与设根（dropOpen），
  // 按返回的打开指令执行：root 非空 → 切换工作区；files → 逐个开 tab
  const handleDropPaths = useCallback(
    async (paths: string[]) => {
      try {
        const { root, files } = await api.dropOpen(paths);
        if (root) await openFolderAt(root);
        files.forEach((f) => openFile(f));
        if (files.length) {
          setStatus(files.length > 1 ? `已打开 ${files.length} 个文件` : `打开：${baseName(files[0])}`);
        } else if (root) {
          setStatus(`工作区：${root}`);
        }
      } catch (e) {
        setStatus((e as Error).message);
      }
    },
    [api, openFolderAt, openFile],
  );

  // §3.6b 拖拽监听：capture 阶段挂在 window 上，先于 Monaco 等内部 drop 处理执行。
  // 仅拦截携带 Files 类型数据的拖拽（文件/文件夹）；纯文本/HTML 拖放放行给编辑器。
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // 必须阻止，否则 Chromium 默认导航到 file:// 且 drop 不触发
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // 拖出窗口边界时 relatedTarget 为 null，清掉遮罩（dragenter/leave 在子元素间
      // 反复触发，不能见 leave 就清）
      if (!e.relatedTarget) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // 文件拖入整体由应用接管，不落到编辑器
      setDragActive(false);
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => api.getPathForFile(f))
        .filter((p): p is string => Boolean(p));
      if (paths.length) void handleDropPaths(paths);
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [api, handleDropPaths]);

  const closeTab = useCallback((filePath: string) => {
    disposeModel(filePath); // §14：关闭标签释放 Monaco model
    setOpenTabs((prev) => prev.filter((t) => t.path !== filePath));
    setActivePath((curr) => {
      if (curr !== filePath) return curr;
      const remaining = openTabsRef.current.filter((t) => t.path !== filePath);
      setActiveMeta(null); // 关闭的是活动标签：清空底部编码信息
      return remaining.length ? remaining[remaining.length - 1].path : null;
    });
  }, []);

  // —— 批量关闭页签（tab 栏右端 ▾ 菜单 / tab 右键菜单）——
  // 统一关闭一组 tab：释放 model、从 openTabs 移除；若含活动 tab，则切到剩余最后一个并清空底部 meta。
  const closeRange = useCallback((closedPaths: string[]) => {
    if (!closedPaths.length) return;
    const closedSet = new Set(closedPaths);
    const remaining = openTabsRef.current.filter((t) => !closedSet.has(t.path));
    closedPaths.forEach((p) => disposeModel(p));
    setOpenTabs(remaining);
    setActivePath((curr) => {
      if (curr && closedSet.has(curr)) {
        setActiveMeta(null);
        return remaining.length ? remaining[remaining.length - 1].path : null;
      }
      return curr;
    });
  }, []);

  const closeTabsLeftOf = useCallback(
    (anchor: string) => {
      const idx = openTabsRef.current.findIndex((t) => t.path === anchor);
      if (idx <= 0) return; // 没有左侧 tab
      closeRange(openTabsRef.current.slice(0, idx).map((t) => t.path));
    },
    [closeRange],
  );

  const closeTabsRightOf = useCallback(
    (anchor: string) => {
      const idx = openTabsRef.current.findIndex((t) => t.path === anchor);
      if (idx < 0 || idx >= openTabsRef.current.length - 1) return; // 没有右侧 tab
      closeRange(openTabsRef.current.slice(idx + 1).map((t) => t.path));
    },
    [closeRange],
  );

  const closeOtherTabs = useCallback(
    (keep: string) => {
      closeRange(openTabsRef.current.filter((t) => t.path !== keep).map((t) => t.path));
    },
    [closeRange],
  );

  const closeAllTabs = useCallback(() => {
    closeRange(openTabsRef.current.map((t) => t.path));
  }, [closeRange]);

  // 构造批量菜单项：anchor 为锚点 tab（null = 相对活动 tab），disabled 按锚点在 openTabs 中的位置
  const buildTabMenuItems = useCallback(
    (anchor: string | null): TabMenuItem[] => {
      const target = anchor ?? activePath;
      const idx = openTabs.findIndex((t) => t.path === target);
      const items: TabMenuItem[] = [];
      if (anchor) items.push({ label: '关闭', onClick: () => closeTab(anchor) });
      items.push({ label: '关闭左侧全部', disabled: idx <= 0, onClick: () => target && closeTabsLeftOf(target) });
      items.push({
        label: '关闭右侧全部',
        disabled: idx < 0 || idx >= openTabs.length - 1,
        onClick: () => target && closeTabsRightOf(target),
      });
      items.push({ label: '关闭其他', disabled: openTabs.length <= 1, onClick: () => target && closeOtherTabs(target) });
      items.push({ label: '关闭全部', onClick: closeAllTabs });
      return items;
    },
    [activePath, openTabs, closeTab, closeTabsLeftOf, closeTabsRightOf, closeOtherTabs, closeAllTabs],
  );

  // —— 文件树写操作（Step 5 / §3.1），输入框/确认走模态框（§3.3）——

  // 实际执行创建（被模态框 onConfirm 调用）。name 支持嵌套路径：
  //   "foo.ts"          -> 父目录下新建
  //   "src/utils/foo.ts"-> 自动创建中间目录并新建（主进程 ensure parent）
  const doCreate = useCallback(
    async (parentDir: string | null, kind: 'file' | 'directory', name: string) => {
      const root = workspaceRootRef.current;
      if (!root || !name) return;
      const parent = parentDir ?? root;
      const target = joinPath(parent, name);
      // 实际父目录 = 目标路径去掉文件名部分（嵌套输入时比 parentDir 深，需刷新到这一层）
      const targetParent = parentOf(target) ?? root;
      try {
        if (kind === 'file') {
          await api.createFile(target);
          await revealDirectory(targetParent);
          openFile(target);
        } else {
          await api.createDirectory(target);
          await revealDirectory(targetParent);
        }
        setStatus('');
      } catch (e) {
        setStatus((e as { code?: string; message: string }).message ?? '创建失败');
      }
    },
    [api, revealDirectory, openFile],
  );

  const requestCreate = useCallback(
    (parentDir: string | null, kind: 'file' | 'directory') => {
      setModal({
        kind: 'input',
        title: kind === 'file' ? '新建文件' : '新建文件夹',
        initialValue: '',
        placeholder:
          kind === 'file' ? '文件名（支持子目录路径，如 src/utils/foo.ts）' : '文件夹名（支持多级路径，如 assets/img）',
        onConfirm: (name) => void doCreate(parentDir, kind, name),
      });
    },
    [doCreate],
  );

  // §3.6c 重命名/移动公共执行：renameEntry + 双目录刷新 + tab 路径迁移 + model 释放。
  // 重命名（同目录）与树内拖拽移动（跨目录）共用；跨目录时源/目标父目录都要刷新，
  // 移动文件夹时其下已打开文件的 tab 路径前缀整体替换（精确匹配只覆盖单文件重命名）。
  const applyRename = useCallback(
    async (oldPath: string, newPath: string, feedback?: string) => {
      try {
        await api.renameEntry(oldPath, newPath);
        const oldParent = parentOf(oldPath);
        const newParent = parentOf(newPath);
        // 双目录刷新：源父目录移除旧条目、目标父目录出现新条目。
        // 目录在根层时 refreshNodeNow 退化为 reloadTree（in-flight 去重，重复调用无害）
        await refreshNodeNow(oldParent);
        await refreshNodeNow(newParent);
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.path === oldPath
              ? { ...t, path: newPath }
              : t.path.startsWith(oldPath + '/')
                ? { ...t, path: newPath + t.path.slice(oldPath.length) }
                : t,
          ),
        );
        // 释放旧路径 model：重命名/移动后 Monaco model 的 path key 已失效，
        // 下次激活时按新路径从磁盘重读（与关闭 tab 同一清理语义，§14）
        openTabsRef.current.forEach((t) => {
          if (t.path === oldPath || t.path.startsWith(oldPath + '/')) disposeModel(t.path);
        });
        const active = activePathRef.current;
        if (active && (active === oldPath || active.startsWith(oldPath + '/'))) {
          const newActive = active === oldPath ? newPath : newPath + active.slice(oldPath.length);
          setActivePath(newActive);
          setReloadSignal({ path: newActive, nonce: Date.now() });
        }
        setStatus(feedback ?? '');
      } catch (e) {
        setStatus((e as { code?: string; message: string }).message ?? '操作失败');
      }
    },
    [api, refreshNodeNow],
  );

  // 实际执行重命名（同目录改名）
  const doRename = useCallback(
    async (node: FileNode, newName: string) => {
      if (!newName || newName === node.name) return;
      const idx = node.path.lastIndexOf('/');
      const parent = idx >= 0 ? node.path.slice(0, idx) : workspaceRootRef.current ?? '';
      const newPath = joinPath(parent, newName);
      await applyRename(node.path, newPath);
    },
    [applyRename],
  );

  // §3.6c 树内拖拽移动：拖源节点 → 目标目录（仅目录节点可作为落点）。
  // 目标路径 = 目标目录 + 源文件名；自子树/自身由主进程 renameEntry 守卫拦截（E_INVALID），
  // 渲染层仍前置快速判断以省去一次必然失败的 IPC。
  const handleMoveNode = useCallback(
    async (source: string, targetDir: string) => {
      setDragOverDir(null);
      if (source === targetDir) return; // 拖到自身（目录拖自己）：无操作
      const target = joinPath(targetDir, baseName(source));
      await applyRename(source, target, `已移动：${baseName(source)} → ${baseName(targetDir)}`);
    },
    [applyRename],
  );

  // §3.6c 拖到树面板空白区域 = 移动到工作区根（与"空白右键新建于根"同语义）。
  // 源已在根目录时 no-op（避免 renameEntry 的 E_INVALID 误报"移进自身"）。
  const handleMoveToRoot = useCallback(
    async (source: string) => {
      setDragOverRoot(false);
      const root = workspaceRootRef.current;
      if (!root || source === root || parentOf(source) === root) return; // 源即根/已在根目录：无操作
      const target = joinPath(root, baseName(source));
      await applyRename(source, target, `已移动：${baseName(source)} → 工作区根`);
    },
    [applyRename],
  );

  // §3.6c 拖拽手势状态回调（FileTree 内部行事件转发到 App，统一持有拖拽状态）
  const handleDragStartNode = useCallback((path: string) => setDragSource(path), []);
  const handleDragEndNode = useCallback(() => {
    setDragSource(null);
    setDragOverDir(null);
    setDragOverRoot(false);
  }, []);
  const handleDragOverDir = useCallback((path: string | null) => setDragOverDir(path), []);
  const handleDragOverRoot = useCallback((active: boolean) => setDragOverRoot(active), []);

  const requestRename = useCallback(
    (node: FileNode) => {
      setModal({
        kind: 'input',
        title: '重命名',
        initialValue: node.name,
        onConfirm: (name) => void doRename(node, name),
      });
    },
    [doRename],
  );

  // 实际执行删除
  const doDelete = useCallback(
    async (node: FileNode) => {
      const idx = node.path.lastIndexOf('/');
      const parent = idx >= 0 ? node.path.slice(0, idx) : workspaceRootRef.current ?? '';
      try {
        await api.deleteEntry(node.path);
        await refreshNodeNow(parent);
        const closesThis = (p: string) => p === node.path || p.startsWith(node.path + '/');
        if (openTabsRef.current.some((t) => closesThis(t.path))) {
          openTabsRef.current.filter((t) => closesThis(t.path)).forEach((t) => disposeModel(t.path));
          setOpenTabs((prev) => prev.filter((t) => !closesThis(t.path)));
          setActivePath((curr) => {
            if (!curr || !closesThis(curr)) return curr;
            const remaining = openTabsRef.current.filter((t) => !closesThis(t.path));
            return remaining.length ? remaining[remaining.length - 1].path : null;
          });
        }
        setStatus('');
      } catch (e) {
        setStatus((e as { code?: string; message: string }).message ?? '删除失败');
      }
    },
    [api, refreshNodeNow],
  );

  const requestDelete = useCallback(
    (node: FileNode) => {
      setModal({
        kind: 'confirm',
        title: '删除确认',
        message: `确认删除 ${node.name}？${node.type === 'directory' ? '（含其下所有内容）' : ''}`,
        onConfirm: () => void doDelete(node),
      });
    },
    [doDelete],
  );

  // 复制文件路径（Step 5 / §3.3）：写入系统剪贴板，状态栏给反馈
  const onCopyPath = useCallback(
    async (node: FileNode) => {
      try {
        await api.copyText(node.path);
        setStatus(`已复制路径：${node.path}`);
      } catch (e) {
        setStatus((e as { message: string }).message ?? '复制路径失败');
      }
    },
    [api],
  );

  const setDirty = useCallback((filePath: string, dirty: boolean) => {
    setOpenTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, isDirty: dirty } : t)));
    // 文件回到"干净"态（保存成功 / 重新加载完成）时，外部修改提示自动消失——
    // 覆盖全部保存入口：Cmd+S（CodeEditor.handleSave -> onDirtyChange(false)）、
    // 保存按钮、关闭保存、自动保存（saveDirtyTabs / saveActive 也走 setDirty）。
    if (!dirty) setExternalNote((cur) => (cur === filePath ? null : cur));
  }, []);

  // 取所有未保存标签的最新内容并写回（复用 modelRegistry 中保留的 model，含非活动标签）。
  // 关闭保存与自动保存共用。§7.3（改版）：一律 force 覆盖写盘（保存 = 用户主动写回），
  // 不再因外部改动返回 E_CONFLICT；单个文件失败不阻断其余。
  const saveDirtyTabs = useCallback(async (): Promise<number> => {
    let saved = 0;
    for (const t of openTabsRef.current) {
      if (!t.isDirty) continue;
      const model = getModel(t.path);
      if (!model) continue;
      try {
        await writeFile(t.path, model.getValue(), { force: true });
        setDirty(t.path, false); // 顺带清除该文件的外部修改提示（见 setDirty）
        saved++;
      } catch (e) {
        setStatus((e as { code?: string; message: string }).message ?? '保存失败');
      }
    }
    return saved;
  }, [writeFile, setDirty]);

  // 工具栏"保存"：写回当前活动文件（Monaco 自身已支持 Cmd/Ctrl+S，此按钮为显式入口）。
  // §7.3（改版）：force 覆盖写盘——用户在浏览区编辑后保存，保存文件即可，不做外部改动拦截。
  // §7.3（改版 v2）：成功后底部反馈"保存成功"。
  const saveActive = useCallback(async () => {
    const p = activePathRef.current;
    if (!p) return;
    const model = getModel(p);
    if (!model) return;
    try {
      await writeFile(p, model.getValue(), { force: true });
      setDirty(p, false); // 顺带清除该文件的外部修改提示（见 setDirty）
      setStatus('');
      showSaveFeedback('保存成功');
    } catch (e) {
      setStatus((e as { code?: string; message: string }).message ?? '保存失败');
    }
  }, [writeFile, setDirty, showSaveFeedback]);

  // §14 关闭客户端提示保存：主进程 close 拦截后回调。有 dirty 则弹三选框，否则直接放行。
  const handleRequestClose = useCallback(() => {
    const dirtyTabs = openTabsRef.current.filter((t) => t.isDirty);
    if (dirtyTabs.length > 0) {
      setCloseModal({ dirtyCount: dirtyTabs.length });
    } else {
      void confirmClose();
    }
  }, [confirmClose]);

  // 注册主进程关闭询问（§14）
  useEffect(() => {
    const unsub = onRequestClose(() => handleRequestClose());
    return unsub;
  }, [onRequestClose, handleRequestClose]);

  // §14 自动定时保存：启用时按间隔写回所有 dirty 标签（间隔下限 1s 防误配）
  useEffect(() => {
    if (!settings.autoSaveEnabled) return;
    const id = setInterval(() => {
      void (async () => {
        const saved = await saveDirtyTabs();
        // §7.3（改版 v2）：确有文件落盘才提示"自动保存成功"（无 dirty 不提示）
        if (saved > 0) showSaveFeedback('自动保存成功');
      })();
    }, Math.max(1000, settings.autoSaveIntervalMs));
    return () => clearInterval(id);
  }, [settings, saveDirtyTabs, showSaveFeedback]);

  const toggleDir = useCallback(
    async (node: FileNode) => {
      setSelectedPath(node.path); // §3.3 选中态
      if (node.loadState === 'loaded') {
        // 收起：退订该目录监听（§9.4 生命周期）
        const id = watchMapRef.current.get(node.path);
        if (id) {
          watchMapRef.current.delete(node.path);
          try {
            await unwatchDir(id);
          } catch {
            /* ignore */
          }
        }
        setTree((prev) => updateNode(prev, node.path, { expanded: !node.expanded }));
        return;
      }
      setTree((prev) => updateNode(prev, node.path, { loadState: 'loading' }));
      try {
        const children = await readDirectory(node.path);
        setTree((prev) =>
          updateNode(prev, node.path, {
            children,
            loadState: children.length ? 'loaded' : 'empty',
            expanded: true,
          }),
        );
        // 展开：watch 该目录（§9.4 生命周期）
        try {
          const { watchId } = await api.watchDir(node.path);
          watchMapRef.current.set(node.path, watchId);
        } catch {
          /* watch 失败不阻断展开 */
        }
      } catch (e) {
        setTree((prev) =>
          updateNode(prev, node.path, { loadState: 'error', loadError: (e as Error).message }),
        );
      }
    },
    [readDirectory, api, unwatchDir],
  );

  // §8.2（改版 v3）外部修改提示条：external 修改 + dirty 时非阻塞提示，双按钮二选一：
  //   - [重新加载外部版本]：先弹应用内二次确认（提示将丢弃未保存改动），确认后才加载外部最新内容。
  //     场景 B 的心智模型默认"我没动、外部动了"，直接重载会误吞正在写的编辑——加确认防误触（§8.2 v3）
  //   - [保留当前版本]：确认继续我的编辑（不写盘、不清 dirty），提示消失；
  //     文件后续再被外部修改会重新触发 fs:changed -> 提示自然重现
  const handleReloadFromNote = useCallback(() => {
    const path = externalNote;
    if (!path) return;
    setModal({
      kind: 'confirm',
      title: '重新加载外部版本',
      message: `将丢弃 ${path} 的未保存改动，确定重新加载外部版本？`,
      confirmLabel: '确定重新加载',
      onConfirm: () => {
        reloadFile(path); // 加载外部最新版本，丢弃当前未保存改动（已获确认）
        setExternalNote(null);
      },
    });
  }, [externalNote, reloadFile]);

  const handleKeepFromNote = useCallback(() => {
    setExternalNote(null); // 保留当前版本：仅关闭提示，不动内容
  }, []);

  // §10 事件订阅（§9.6 已区分 source）。本 effect 仅订阅一次（依赖稳定）。
  useEffect(() => {
    const unsub = window.fileAPI.onFileChanged((e: FsChangeEvent) => {
      const tabs = openTabsRef.current;
      const tab = tabs.find((t) => t.path === e.path);
      // §9.4 生命周期补全：目录被删除时回收其子树全部监听（self/external 都要），
      // 否则 chokidar watcher 与 watchMap 条目随删除操作持续泄漏
      if (e.kind === 'directory' && e.type === 'deleted') {
        const map = watchMapRef.current;
        for (const [dir, id] of map) {
          if (dir === e.path || dir.startsWith(e.path + '/')) {
            void unwatchDir(id).catch(() => {});
            map.delete(dir);
          }
        }
      }
      if (e.source === 'external') {
        if (tab && tab.isDirty) {
          setActivePath(e.path); // 定位到受影响文件（不打断编辑）
          // §8.2（改版 v2）：非阻塞提示条 + 双按钮（重新加载外部版本 / 保留当前版本），
          // 不再拦截保存——任何保存入口（Cmd+S / 保存按钮 / 关闭保存 / 自动保存）仍直接
          // force 覆盖写盘；提示条只承担"告知 + 授权决策"，不裁决。
          setExternalNote(e.path);
          return;
        }
        if (tab && !tab.isDirty) {
          reloadFile(e.path); // §8.2：已保存 -> 自动重载
          void refreshGitStatus(); // §15 git 状态随之变化
          return;
        }
        // 未打开文件：局部刷新变动的父目录（保住其他目录展开状态，§9.4 已 watch）
        scheduleRefreshNode(parentOf(e.path));
      } else {
        // self：不弹窗，局部刷新保持一致（rename 的 unlink+add 双事件经 150ms 去重合并）
        scheduleRefreshNode(parentOf(e.path));
      }
      void refreshGitStatus(); // §15 任何文件改动后更新装饰（主进程侧节流）
    });
    return unsub;
  }, [scheduleRefreshNode, reloadFile, refreshGitStatus, unwatchDir]);

  // 卸载时退订全部监听（§9.4 生命周期）。先取 ref 指向的 Map 实例再在清理中使用
  //（ref 身份恒定，行为等价，同时满足 react-hooks 对 cleanup 引用 ref 的静态检查）
  useEffect(() => {
    const watchMap = watchMapRef.current;
    return () => {
      watchMap.forEach((id) => {
        void unwatchDir(id).catch(() => {});
      });
      watchMap.clear();
    };
  }, [unwatchDir]);

  // 卸载时取消未执行的合并刷新（防止 timer 在卸载后触发 setState）
  useEffect(() => {
    const timers = refreshTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return (
    <div style={styles.app}>
      <div style={styles.toolbar}>
        <button onClick={openFolder}>打开文件夹</button>
        <button onClick={saveActive} disabled={!activePath}>
          保存
        </button>
        <button onClick={() => editorRef.current?.undo()} disabled={!activePath} title="撤销 (Ctrl+Z)">
          回退
        </button>
        <button onClick={() => editorRef.current?.redo()} disabled={!activePath} title="重做 (Ctrl+Y)">
          前进
        </button>
        <button onClick={() => setSettingsOpen(true)}>设置</button>
        <span style={styles.root}>{workspaceRoot ?? '未选择工作区'}</span>
        {status && <span style={styles.status}>{status}</span>}
      </div>

      {externalNote && (
        <div style={styles.banner}>
          <span>
            文件 <code>{externalNote}</code> 在外部被修改：重新加载将丢弃当前未保存改动，保留则继续编辑当前版本。
          </span>
          <button onClick={handleReloadFromNote}>重新加载外部版本</button>
          <button onClick={handleKeepFromNote}>保留当前版本</button>
        </div>
      )}

      <div style={styles.body}>
        <div style={{ ...styles.sidebar, width: sidebarWidth }}>
          {workspaceRoot ? (
            <FileTree
              nodes={tree}
              onToggleDir={toggleDir}
              onOpenFile={openFile}
              onNewFile={(dir) => requestCreate(dir || null, 'file')}
              onNewFolder={(dir) => requestCreate(dir || null, 'directory')}
              onRename={requestRename}
              onDelete={requestDelete}
              onCopyPath={onCopyPath}
              selectedPath={selectedPath}
              gitFileMap={gitFileMap}
              gitDirMap={gitDirMap}
              onMoveDrop={handleMoveNode}
              dragSource={dragSource}
              dragOverDir={dragOverDir}
              onDragStartNode={handleDragStartNode}
              onDragEndNode={handleDragEndNode}
              onDragOverDir={handleDragOverDir}
              onMoveToRoot={handleMoveToRoot}
              dragOverRoot={dragOverRoot}
              onDragOverRoot={handleDragOverRoot}
            />
          ) : (
            <div style={styles.hint}>点击“打开文件夹”选择一个目录</div>
          )}
        </div>

        <div
          style={{ ...styles.splitter, ...(isResizing ? styles.splitterActive : {}) }}
          onMouseDown={onSplitterDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整侧栏宽度"
        />

        <div style={styles.editorArea}>
          {activePath ? (
            <>
              <div style={styles.tabBar}>
                {openTabs.map((t) => (
                  <span
                    key={t.path}
                    style={{ ...styles.tab, ...(t.path === activePath ? styles.tabActive : {}) }}
                    onClick={() => setActivePath(t.path)}
                    onContextMenu={(e) => {
                      // tab 右键菜单：关闭 / 关闭左侧全部 / 关闭右侧全部 / 关闭其他 / 关闭全部
                      e.preventDefault();
                      e.stopPropagation();
                      setTabMenu({
                        x: Math.min(e.clientX, window.innerWidth - 150),
                        y: Math.min(e.clientY, window.innerHeight - 170),
                        anchor: t.path,
                      });
                    }}
                  >
                    {t.path.split('/').pop()}
                    {t.isDirty ? ' •' : ''}
                    <span
                      style={styles.tabClose}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        closeTab(t.path);
                      }}
                    >
                      ×
                    </span>
                  </span>
                ))}
                {/* 批量关闭页签：右侧常驻 ▾ 菜单（sticky 防横向滚动时被挤出） */}
                <div style={styles.tabBarActions}>
                  <button
                    style={styles.tabBarBtn}
                    title="批量关闭页签（关闭左侧全部 / 关闭右侧全部 / 关闭全部）"
                    aria-label="批量关闭页签"
                    onClick={(e) =>
                      setTabMenu({
                        x: Math.max(4, e.clientX - 120),
                        y: Math.min(e.clientY + 22, window.innerHeight - 170),
                        anchor: null, // 锚点 = 活动 tab
                      })
                    }
                  >
                    ▾
                  </button>
                </div>
                {tabMenu && (
                  <>
                    <div
                      style={styles.menuBackdrop}
                      onClick={closeTabMenu}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        closeTabMenu();
                      }}
                    />
                    <div style={{ ...styles.ctxMenu, left: tabMenu.x, top: tabMenu.y }}>
                      {buildTabMenuItems(tabMenu.anchor).map((it) => (
                        <button
                          key={it.label}
                          style={{ ...styles.ctxItem, ...(it.disabled ? { color: '#bbb', cursor: 'default' } : {}) }}
                          disabled={it.disabled}
                          onClick={() => {
                            it.onClick();
                            closeTabMenu();
                          }}
                        >
                          {it.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {isImage(activePath) ? (
                // key={activePath}：切换图片时重挂载以重置加载状态（替代 effect 内同步 setState，
                // 符合 react-hooks/set-state-in-effect；ImageViewer 为纯展示组件，重挂载零副作用）
                <ImageViewer key={activePath} filePath={activePath} />
              ) : (
                // §13 预览路由门：pdf/docx 等二进制文件在此分流到"暂不支持浏览"提示页，
                // 不再落入 Monaco 底部红字错误条。
                // key={activePath}：切文件即重挂载，FilePreviewGate 的 checking 态由
                // 初始 state 承担（不再 effect 内同步 setState，杜绝渲染循环；CodeEditor
                // 自身已有 key={p} 会重挂载，Monaco model 复用走 modelRegistry 不受影响）
                <FilePreviewGate
                  key={activePath}
                  filePath={activePath}
                  renderEditor={(p) => (
                    <CodeEditor
                      key={p}
                      ref={editorRef}
                      filePath={p}
                      onDirtyChange={(dirty) => setDirty(p, dirty)}
                      reloadSignal={reloadSignal}
                      onMeta={setActiveMeta}
                      onSaved={() => showSaveFeedback('保存成功')}
                    />
                  )}
                />
              )}
            </>
          ) : (
            <div style={styles.hint}>选择一个文件开始编辑</div>
          )}
        </div>
      </div>

      {/* §13 底部状态栏：左 = 当前文件/工作区，中 = 保存反馈，右 = 编码 · 换行符（UTF-8 无 BOM 约定） */}
      <div style={styles.statusBar}>
        <span style={styles.statusBarPath}>{activePath ?? (workspaceRoot ?? '未打开工作区')}</span>
        {saveFeedback && <span style={styles.statusBarFeedback}>{saveFeedback.text}</span>}
        <span style={styles.statusBarMeta}>
          {/* 图片无编码/换行符概念：无条件不显示，避免残留上一个文本文件的脏 meta（tab 切换不经过 CodeEditor） */}
          {!activePath || isImage(activePath)
            ? ''
            : activeMeta
              ? `${activeMeta.encoding.toUpperCase()} · ${activeMeta.eol}`
              : '读取中…'}
        </span>
      </div>

      {modal?.kind === 'input' && (
        <InputModal
          title={modal.title}
          initialValue={modal.initialValue}
          placeholder={modal.placeholder}
          onConfirm={(value) => {
            modal.onConfirm(value);
            setModal(null);
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'confirm' && (
        <ConfirmModal
          title={modal.title}
          message={modal.message}
          confirmLabel={modal.confirmLabel}
          onConfirm={() => {
            modal.onConfirm();
            setModal(null);
          }}
          onCancel={() => setModal(null)}
        />
      )}

      {closeModal && (
        <CloseConfirmModal
          dirtyCount={closeModal.dirtyCount}
          onSave={async () => {
            await saveDirtyTabs();
            setCloseModal(null);
            void api.confirmClose();
          }}
          onDiscard={() => {
            setCloseModal(null);
            void api.confirmClose();
          }}
          onCancel={() => setCloseModal(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={(next) => {
            setSettings(next);
            saveSettings(next);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* §3.6b 拖拽打开：系统文件/文件夹悬停窗口时的全局遮罩（pointerEvents none，
          不拦截事件；drop 仍由 window capture 监听处理） */}
      {dragActive && (
        <div style={styles.dropOverlay}>
          <div style={styles.dropOverlayBox}>松开以打开文件 / 文件夹</div>
        </div>
      )}
    </div>
  );
}
