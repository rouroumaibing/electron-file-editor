// src/renderer/components/FileTree.tsx
// 文件树（递归、懒加载）。每个目录节点按需展开，展开时由上层 readDirectory 填充 children。
// 右键上下文菜单（Step 5 / §3.1）：节点右键 -> 目录可新建文件/文件夹（新建于自身）、文件可新建于父目录、
// 所有节点可重命名/删除/复制路径；空白区域右键 -> 新建于工作区根（空工作区 / 树外空白处的新建入口）。
// §3.6c 树内拖拽移动：所有行可拖（draggable + 自定义 MIME 传源路径）；仅目录行可作为落点
// （dragover/drop），拖入自身或自身后代为非法目标（dropEffect none，不触发 drop）。
import { useState } from 'react';
import type { DragEvent } from 'react';
import type { FileNode } from '@shared/types/fs';
import type { GitStatusCode } from '@shared/types/git';
import { styles } from '../styles';

// §3.6c 拖拽传输的自定义 MIME：内部节点拖拽专用（与系统文件拖入的 Files 类型互不干扰，
// 窗口级 §3.6b 监听仅拦截 Files 类型，会自然放行本类型拖拽）
const TREE_DND_MIME = 'application/x-file-editor-path';

// §15 Git 状态高亮：颜色（light 主题基准）+ 单字母徽标
const GIT_COLORS: Record<GitStatusCode, string> = {
  M: '#e2c08d', // 黄
  A: '#73c991', // 绿
  U: '#73c991', // 绿（未跟踪）
  D: '#f14c4c', // 红
  C: '#f14c4c', // 红（冲突）
  R: '#e2c08d', // 黄
};
const GIT_BADGE: Record<GitStatusCode, string> = { M: 'M', A: 'A', U: 'U', D: 'D', C: '!', R: 'R' };

interface Props {
  nodes: FileNode[];
  onToggleDir: (node: FileNode) => void;
  onOpenFile: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onCopyPath: (node: FileNode) => void;
  selectedPath: string | null; // §3.3 选中态高亮
  gitFileMap: Map<string, GitStatusCode>; // §15 文件精确映射
  gitDirMap: Map<string, GitStatusCode>; // §15 目录聚合映射
  // §3.6c 拖拽移动：落点回调 + 拖拽状态（源路径 / 悬停目标，由 App 统一持有）
  onMoveDrop: (sourcePath: string, targetDirPath: string) => void;
  dragSource: string | null;
  dragOverDir: string | null;
  onDragStartNode: (path: string) => void;
  onDragEndNode: () => void;
  onDragOverDir: (path: string | null) => void;
  // §3.6c 根落点：树面板空白区域 = 工作区根（与"空白右键新建于根"同语义）
  onMoveToRoot: (sourcePath: string) => void;
  dragOverRoot: boolean; // 空白区域悬停高亮
  onDragOverRoot: (active: boolean) => void;
  depth?: number;
}

interface MenuState {
  node: FileNode | null; // null = 空白区域右键，目标为工作区根
  x: number;
  y: number;
}

export function FileTree({
  nodes,
  onToggleDir,
  onOpenFile,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopyPath,
  selectedPath,
  gitFileMap,
  gitDirMap,
  onMoveDrop,
  dragSource,
  dragOverDir,
  onDragStartNode,
  onDragEndNode,
  onDragOverDir,
  onMoveToRoot,
  dragOverRoot,
  onDragOverRoot,
  depth = 0,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const closeMenu = () => setMenu(null);

  // §3.6c 判断目标目录是否可接收拖拽：非自身、非自身后代（拖目录进自己的子树会无限递归）
  const canDropInto = (targetPath: string, source: string | null): boolean =>
    Boolean(source) && source !== targetPath && !targetPath.startsWith(source + '/');

  // §3.6c 行拖拽事件（React 合成 DragEvent）
  const handleRowDragStart = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    // setData 必须有值，否则 Chromium 不启动拖拽
    e.dataTransfer.setData(TREE_DND_MIME, node.path);
    e.dataTransfer.effectAllowed = 'move';
    onDragStartNode(node.path);
  };

  const handleDirDragOver = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    if (!canDropInto(node.path, dragSource)) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    // 必须 preventDefault 才能成为 drop 目标
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOverDir(node.path);
  };

  const handleDirDragLeave = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    // 仅在真正离开行时清除高亮：relatedTarget 仍在行内（拖过子行）则保留
    const next = e.relatedTarget as Node | null;
    if (dragOverDir === node.path && (!next || !e.currentTarget.contains(next))) {
      onDragOverDir(null);
    }
  };

  const handleDirDrop = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation(); // 不冒泡到外层容器/其他处理器（窗口级监听只认 Files 类型，本就放行）
    const source = e.dataTransfer.getData(TREE_DND_MIME);
    if (source && canDropInto(node.path, source)) onMoveDrop(source, node.path);
  };

  // §3.6c 树面板空白区域 = 工作区根落点：拖到任何空白处（非行元素）即"移动到根目录"。
  // 仅根层容器挂载（depth===0），子层级空白的事件冒泡到根容器统一判定；
  // 落在行上则让位——目录行自行处理（高亮/落点），文件行无效（不 preventDefault）。
  const isTreeRow = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && Boolean(t.closest('[data-tree-row]'));

  const handlePanelDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragSource) return; // 非内部节点拖拽（外部 Files 拖入由窗口级 §3.6b 处理）
    if (isTreeRow(e.target)) {
      onDragOverRoot(false); // 落在行上：根高亮让位（目录行会自己置 dragOverDir 高亮）
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOverRoot(true);
  };

  const handlePanelDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // HTML5 DnD 中 dragleave 的 relatedTarget 多为 null，不能依赖它判断是否离开容器；
    // 改用鼠标坐标：仍在容器矩形内则保留高亮，拖出边界（进入编辑区/窗口外）才清除
    const rect = e.currentTarget.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) onDragOverRoot(false);
  };

  const handlePanelDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragSource || isTreeRow(e.target)) return; // 行上的 drop 由目录行处理（已 stopPropagation）
    e.preventDefault();
    e.stopPropagation();
    onDragOverRoot(false);
    const source = e.dataTransfer.getData(TREE_DND_MIME);
    if (source) onMoveToRoot(source);
  };

  return (
    <div
      style={{
        position: 'relative',
        // 根容器铺满侧栏可视高度：sidebar 是 overflow:auto 滚动容器，若容器高度只等于树内容
        // 高度，节点下方的空白就不在容器内，dragover/drop 不会触发（拖到空白无高亮）。
        // minHeight 100% 使整个侧栏可视区都属于容器，空白区域即根落点。
        ...(depth === 0 ? { minHeight: '100%' } : {}),
        ...(depth === 0 && dragOverRoot ? styles.panelDragOver : {}),
      }}
      onContextMenu={(e) => {
        // 空白区域右键：新建于工作区根（节点自身的 onContextMenu 已 stopPropagation，不会冒泡到这里）
        e.preventDefault();
        setMenu({ node: null, x: e.clientX, y: e.clientY });
      }}
      {...(depth === 0
        ? {
            onDragOver: handlePanelDragOver,
            onDragLeave: handlePanelDragLeave,
            onDrop: handlePanelDrop,
          }
        : {})}
    >
      <ul style={{ listStyle: 'none', margin: 0, paddingLeft: depth === 0 ? 0 : 12 }}>
        {nodes.map((node) => (
          <li key={node.path}>
            <div
              draggable
              data-tree-row={node.path}
              onDragStart={handleRowDragStart(node)}
              onDragEnd={onDragEndNode}
              onDragOver={node.type === 'directory' ? handleDirDragOver(node) : undefined}
              onDragLeave={node.type === 'directory' ? handleDirDragLeave(node) : undefined}
              onDrop={node.type === 'directory' ? handleDirDrop(node) : undefined}
              onClick={() => (node.type === 'directory' ? onToggleDir(node) : onOpenFile(node.path))}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation(); // 节点右键交给节点菜单，不落到空白区域菜单
                setMenu({ node, x: e.clientX, y: e.clientY });
              }}
              style={{
                ...styles.row,
                ...(selectedPath === node.path ? styles.rowSelected : {}),
                ...(dragOverDir === node.path ? styles.rowDragOver : {}),
                ...(dragSource === node.path ? styles.rowDragging : {}),
              }}
            >
              {(() => {
                // §15：目录取聚合态（无徽标），文件取精确态（带徽标）
                const code = node.type === 'directory' ? gitDirMap.get(node.path) : gitFileMap.get(node.path);
                const color = code ? GIT_COLORS[code] : undefined;
                return (
                  <span style={color ? { color } : undefined}>
                    {node.type === 'directory' ? (node.expanded ? '▾' : '▸') : '📄'} {node.name}
                    {code && node.type === 'file' && (
                      <sup style={{ fontSize: 9, marginLeft: 3 }}>{GIT_BADGE[code]}</sup>
                    )}
                  </span>
                );
              })()}
            </div>

            {node.type === 'directory' && node.expanded && node.children && (
              <FileTree
                nodes={node.children}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onRename={onRename}
                onDelete={onDelete}
                onCopyPath={onCopyPath}
                selectedPath={selectedPath}
                gitFileMap={gitFileMap}
                gitDirMap={gitDirMap}
                onMoveDrop={onMoveDrop}
                dragSource={dragSource}
                dragOverDir={dragOverDir}
                onDragStartNode={onDragStartNode}
                onDragEndNode={onDragEndNode}
                onDragOverDir={onDragOverDir}
                onMoveToRoot={onMoveToRoot}
                dragOverRoot={dragOverRoot}
                onDragOverRoot={onDragOverRoot}
                depth={depth + 1}
              />
            )}
            {node.loadState === 'loading' && <div style={styles.sub}>加载中…</div>}
            {node.loadState === 'error' && <div style={styles.err}>加载失败：{node.loadError}</div>}
            {node.loadState === 'empty' && <div style={styles.sub}>（空目录）</div>}
          </li>
        ))}
      </ul>

      {menu && (() => {
        const n = menu.node; // 局部常量：保证 TS 在回调闭包内的空值收缩可靠
        // 新建目标目录：空白区 -> ''（工作区根）；目录节点 -> 自身；文件节点 -> 所在父目录
        const slash = n ? n.path.lastIndexOf('/') : -1;
        const targetDir = n === null ? '' : n.type === 'directory' ? n.path : slash > 0 ? n.path.slice(0, slash) : '';
        const showTargetHint = n === null || n.type === 'file'; // 目录节点目标即自身，无需提示
        return (
          <>
            <div style={styles.menuBackdrop} onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
            <div style={{ ...styles.ctxMenu, left: menu.x, top: menu.y }}>
              {showTargetHint && (
                <div style={{ ...styles.sub, padding: '4px 10px' }}>
                  新建于：{targetDir ? targetDir.split('/').pop() : '工作区根'}
                </div>
              )}
              <button style={styles.ctxItem} onClick={() => { onNewFile(targetDir); closeMenu(); }}>
                新建文件
              </button>
              <button style={styles.ctxItem} onClick={() => { onNewFolder(targetDir); closeMenu(); }}>
                新建文件夹
              </button>
              {n && (
                <>
                  <button style={styles.ctxItem} onClick={() => { onRename(n); closeMenu(); }}>
                    重命名
                  </button>
                  <button style={styles.ctxItem} onClick={() => { onDelete(n); closeMenu(); }}>
                    删除
                  </button>
                  <button style={styles.ctxItem} onClick={() => { onCopyPath(n); closeMenu(); }}>
                    复制文件路径
                  </button>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}
