// src/renderer/components/FileTree.tsx
//
// 文件树（递归、懒加载）—— TRAE IDE 风格。
// 特性：
//   - 分区标题栏（"文件"）+ 工具栏按钮（新建文件/文件夹、刷新、折叠）
//   - 文件类型图标 + 颜色编码名称
//   - Git 状态徽标靠右显示（M/A/U/D/C）
//   - 目录展开/收起箭头 + 文件夹图标
//   - 右键上下文菜单
//   - §3.6c 树内拖拽移动
import { useState, useCallback } from 'react';
import type { DragEvent } from 'react';
import type { FileNode } from '@shared/types/fs';
import type { GitStatusCode } from '@shared/types/git';
import type { ThemeTokens } from '../theme';
import { getFileColorToken } from '../theme';

const TREE_DND_MIME = 'application/x-file-editor-path';

// —— 文件类型图标（SVG inline，TRAE 风格）——

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
      <path
        d={open
          ? "M1.5 3.5h4.1l1.4 1.5H14.5V13h-13V3.5z"
          : "M1.5 3.5h4.1l1.4-1.5H14.5v11h-13V3.5z"}
        fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon({ name }: { name: string }) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  // 根据扩展名选择不同图标
  if (['.md', '.mdx', '.markdown'].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
        <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1"/>
        <line x1="5" y1="5.5" x2="11" y2="5.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <line x1="5" y1="10.5" x2="9" y2="10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    );
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
        <rect x="3" y="1.5" width="10" height="13" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
        <text x="8" y="10.5" textAnchor="middle" fontSize="6.5" fill="currentColor" fontWeight="bold">{ext.includes('ts') ? 'TS' : 'JS'}</text>
      </svg>
    );
  }
  if (['.json', '.yml', '.yaml'].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
        <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1"/>
        <text x="8" y="10" textAnchor="middle" fontSize="5" fill="currentColor" fontWeight="bold">{ext === '.json' ? '{}' : '<>'}</text>
      </svg>
    );
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
        <rect x="2" y="2.5" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1"/>
        <circle cx="5.5" cy="6" r="1.5" fill="currentColor" opacity="0.5"/>
        <path d="M2.5 11l3-3 2.5 2.5L11 7l2.5 4.5V12a1 1 0 01-1 1h-10a1 1 0 01-1-1v-.5z" fill="currentColor" opacity="0.25"/>
      </svg>
    );
  }
  // 默认文件图标
  const lower = name.toLowerCase();
  if (lower === 'license' || lower === 'licence') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
        <path d="M7.5 1.5L2 5v8.5A1.5 1.5 0 003.5 15h9a1.5 1.5 0 001.5-1.5V5L8.5 1.5h-1z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
        <path d="M7.5 1.5V5.5H2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
        <circle cx="8" cy="9" r="1.5" fill="none" stroke="currentColor" strokeWidth="1"/>
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginRight: 4 }}>
      <path d="M3 2.5h7l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1v-10a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M10 2.5V5.5h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  );
}

// —— 展开/收起箭头 ——
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

// —— Git 状态徽标颜色映射 ——
function gitBadgeColor(code: GitStatusCode, t: ThemeTokens): string {
  switch (code) {
    case 'M': case 'R': return t.gitModified;
    case 'A': return t.gitAdded;
    case 'U': return t.gitUntracked;
    case 'D': return t.gitDeleted;
    case 'C': return t.gitConflict;
    case 'I': return t.textMuted; // ignored -> 灰
  }
}

const GIT_BADGE_LABEL: Record<GitStatusCode, string> = { M: 'M', A: 'A', U: 'U', D: 'D', C: '!', R: 'R', I: 'I' };

interface Props {
  nodes: FileNode[];
  onToggleDir: (node: FileNode) => void;
  onOpenFile: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  // 标题栏"＋/新建文件夹"的目标目录（selectedDir；'' = 工作区根），与右键菜单的
  // 局部 targetDir 区分：右键固定作用于被右键节点，标题栏作用于当前选中目录。
  creationDir: string;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onCopyPath: (node: FileNode) => void;
  selectedPath: string | null;
  gitFileMap: Map<string, GitStatusCode>;
  gitDirMap: Map<string, GitStatusCode>;
  onMoveDrop: (sourcePath: string, targetDirPath: string) => void;
  dragSource: string | null;
  dragOverDir: string | null;
  onDragStartNode: (path: string) => void;
  onDragEndNode: () => void;
  onDragOverDir: (path: string | null) => void;
  onMoveToRoot: (sourcePath: string) => void;
  dragOverRoot: boolean;
  onDragOverRoot: (active: boolean) => void;
  depth?: number;
  theme: ThemeTokens;
  collapsed?: boolean;           // 分区是否整体折叠
  onToggleCollapse?: () => void; // 切换分区折叠
  onRefresh?: () => void;         // 刷新文件树
}

interface MenuState {
  node: FileNode | null;
  x: number;
  y: number;
}

export function FileTree({
  nodes,
  onToggleDir,
  onOpenFile,
  onNewFile,
  onNewFolder,
  creationDir,
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
  theme: t,
  collapsed = false,
  onToggleCollapse,
  onRefresh,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = () => setMenu(null);

  const canDropInto = (targetPath: string, source: string | null): boolean =>
    Boolean(source) && source !== targetPath && !targetPath.startsWith(source + '/');

  const handleRowDragStart = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TREE_DND_MIME, node.path);
    e.dataTransfer.effectAllowed = 'move';
    onDragStartNode(node.path);
  };

  const handleDirDragOver = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    if (!canDropInto(node.path, dragSource)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOverDir(node.path);
  };

  const handleDirDragLeave = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (dragOverDir === node.path && (!next || !e.currentTarget.contains(next))) {
      onDragOverDir(null);
    }
  };

  const handleDirDrop = (node: FileNode) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const source = e.dataTransfer.getData(TREE_DND_MIME);
    if (source && canDropInto(node.path, source)) onMoveDrop(source, node.path);
  };

  const isTreeRow = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && Boolean(t.closest('[data-tree-row]'));

  const handlePanelDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragSource) return;
    if (isTreeRow(e.target)) { onDragOverRoot(false); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOverRoot(true);
  };

  const handlePanelDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) onDragOverRoot(false);
  };

  const handlePanelDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragSource || isTreeRow(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    onDragOverRoot(false);
    const source = e.dataTransfer.getData(TREE_DND_MIME);
    if (source) onMoveToRoot(source);
  };

  // 行悬停高亮状态（用于工具栏按钮 hover 效果）
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  // 渲染单行内容（图标 + 名称 + Git 徽标）
  const renderRowContent = useCallback((node: FileNode) => {
    const code = node.type === 'directory' ? gitDirMap.get(node.path) : gitFileMap.get(node.path);
    const colorKey = node.type === 'directory' ? 'folderColor' : getFileColorToken(node.name);
    // §TRAE-对齐：被 .gitignore 忽略的项（'I'）置灰，不再用文件类型彩色
    const nameColor = code === 'I' ? t.textMuted : t[colorKey];

    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, color: code === 'I' ? t.textMuted : undefined }}>
        {/* 展开/收起箭头（仅目录） */}
        {node.type === 'directory' && (
          <ChevronIcon expanded={!!node.expanded} />
        )}
        {/* 文件类型占位（非目录，保持对齐） */}
        {node.type !== 'directory' && <span style={{ width: 14, flexShrink: 0 }} />}
        {/* 图标 */}
        {node.type === 'directory'
          ? <FolderIcon open={!!node.expanded} />
          : <FileIcon name={node.name} />
        }
        {/* 名称 */}
        <span style={{
          color: nameColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {node.name}
        </span>
      </span>
    );
  }, [gitFileMap, gitDirMap, t]);

  // 渲染 Git 状态徽标（行右侧）
  const renderGitBadge = useCallback((node: FileNode) => {
    const code = node.type === 'directory' ? gitDirMap.get(node.path) : gitFileMap.get(node.path);
    if (!code) {
      // 目录无 git 变更时：显示绿色小圆点（TRAE 风格）
      if (node.type === 'directory') {
        return (
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: t.dotClean,
            flexShrink: 0, marginLeft: 'auto',
          }} />
        );
      }
      return null;
    }
    // 被忽略项：灰色文本已表达状态，右侧不再显示绿色圆点 / 彩色徽标（对齐 TRAE IDE）
    if (code === 'I') return null;
    return (
      <sup style={{
        fontSize: 10, fontWeight: 700, marginLeft: 'auto', padding: '0 3px',
        color: gitBadgeColor(code, t), flexShrink: 0, lineHeight: '16px',
      }}>
        {GIT_BADGE_LABEL[code]}
      </sup>
    );
  }, [gitFileMap, gitDirMap, t]);

  return (
    <div
      style={{
        position: 'relative',
        ...(depth === 0 ? { minHeight: '100%', display: 'flex', flexDirection: 'column' } : {}),
        ...(depth === 0 && dragOverRoot ? { background: t.bgRowHover, borderRadius: 4 } : {}),
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ node: null, x: e.clientX, y: e.clientY });
      }}
      {...(depth === 0
        ? { onDragOver: handlePanelDragOver, onDragLeave: handlePanelDragLeave, onDrop: handlePanelDrop }
        : {})}
    >
      {/* ===== TRAE IDE 风格：分区标题栏（仅根层） ===== */}
      {depth === 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 10px 4px', userSelect: 'none', flexShrink: 0,
        }}>
          {/* 左侧：分区标题（可折叠） */}
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}
            onClick={onToggleCollapse}
          >
            <ChevronIcon expanded={!collapsed} />
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted }}>
              文件
            </span>
          </div>

          {/* 右侧：工具栏按钮 */}
          {!collapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <button title="新建文件" style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '2px 4px',
                borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={() => onNewFile?.(creationDir)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                  <path d="M7 2v10M2 7h10"/>
                </svg>
              </button>
              <button title="新建文件夹" style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '2px 4px',
                borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={() => onNewFolder?.(creationDir)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 3.5h4l1.5-1.5h5v9h-10.5V3.5z"/>
                </svg>
              </button>
              <button title="刷新" style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '2px 4px',
                borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={onRefresh}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 7a6 6 0 0110.5-4"/>
                  <path d="M13 7a6 6 0 01-10.5 4"/>
                  <path d="M11.5 2v2.5H9"/>
                  <path d="M2.5 12V9.5H5"/>
                </svg>
              </button>
              <button title="全部折叠" style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '2px 4px',
                borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={onToggleCollapse}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 3h10M2 7h10M2 11h10"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ===== 文件列表 ===== */}
      {!collapsed && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: '2px 0',
            flex: 1,
            overflow: 'hidden',
            // 根层：轻微左缩进；子目录层：左引导线 + 缩进，明确层级归属
            ...(depth === 0
              ? { paddingLeft: 4 }
              : { marginLeft: 9, paddingLeft: 11, borderLeft: `1px solid ${t.borderLight}` }),
          }}
        >
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
                  e.stopPropagation();
                  setMenu({ node, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={() => setHoveredRow(node.path)}
                onMouseLeave={() => setHoveredRow(null)}
                style={{
                  ...{
                    padding: '1px 8px', cursor: 'pointer', borderRadius: 3,
                    display: 'flex', alignItems: 'center', gap: 2,
                    fontSize: 13, lineHeight: '24px', position: 'relative',
                    userSelect: 'none',
                    ...(selectedPath === node.path ? { background: t.bgRowSelected } : {}),
                    ...(dragOverDir === node.path ? { background: t.bgRowHover, outline: `1px dashed ${t.accent}`, outlineOffset: -1 } : {}),
                    ...(dragSource === node.path ? { opacity: 0.45 } : {}),
                  },
                  ...(hoveredRow === node.path ? { background: selectedPath === node.path ? t.bgRowSelected : t.bgRowHover } : {}),
                }}
              >
                {renderRowContent(node)}
                {renderGitBadge(node)}
              </div>

              {node.type === 'directory' && node.expanded && node.children && (
                <FileTree
                  nodes={node.children}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onNewFile={onNewFile}
                  onNewFolder={onNewFolder}
                  creationDir={creationDir}
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
                  theme={t}
                  collapsed={collapsed}
                  onToggleCollapse={onToggleCollapse}
                  onRefresh={onRefresh}
                />
              )}
              {node.loadState === 'loading' && <div style={{ ...{ padding: '2px 16px', color: t.textMuted, fontSize: 12 }, paddingLeft: String(16 + (depth + 1) * 18) + 'px' }}>加载中…</div>}
              {node.loadState === 'error' && <div style={{ ...{ padding: '2px 16px', color: t.danger, fontSize: 12 }, paddingLeft: String(16 + (depth + 1) * 18) + 'px' }}>加载失败：{node.loadError}</div>}
              {node.loadState === 'empty' && <div style={{ ...{ padding: '2px 16px', color: t.textMuted, fontSize: 12 }, paddingLeft: String(16 + (depth + 1) * 18) + 'px' }}>（空目录）</div>}
            </li>
          ))}
        </ul>
      )}

      {/* ===== 右键菜单 ===== */}
      {menu && (() => {
        const n = menu.node;
        const slash = n ? n.path.lastIndexOf('/') : -1;
        const targetDir = n === null ? '' : n.type === 'directory' ? n.path : slash > 0 ? n.path.slice(0, slash) : '';
        const showTargetHint = n === null || n.type === 'file';
        return (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 100 }} onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
            <div style={{
              position: 'fixed', zIndex: 101, left: menu.x, top: menu.y,
              background: t.bgCtxMenu, border: `1px solid ${t.border}`, borderRadius: 6,
              boxShadow: t.shadowCtxMenu, padding: 4, display: 'flex', flexDirection: 'column', minWidth: 150,
            }}>
              {showTargetHint && (
                <div style={{ padding: '4px 12px', fontSize: 11, color: t.textMuted }}>
                  新建于：{targetDir ? targetDir.split('/').pop() : '工作区根'}
                </div>
              )}
              <button style={{
                textAlign: 'left', background: 'transparent', border: 'none',
                padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.textPrimary,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={() => { onNewFile(targetDir); closeMenu(); }}>
                新建文件
              </button>
              <button style={{
                textAlign: 'left', background: 'transparent', border: 'none',
                padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.textPrimary,
              }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                 onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                 onClick={() => { onNewFolder(targetDir); closeMenu(); }}>
                新建文件夹
              </button>
              {n && (
                <>
                  <div style={{ height: 1, background: t.border, margin: '3px 6px' }} />
                  <button style={{
                    textAlign: 'left', background: 'transparent', border: 'none',
                    padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.textPrimary,
                  }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                     onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                     onClick={() => { onRename(n); closeMenu(); }}>
                    重命名
                  </button>
                  <button style={{
                    textAlign: 'left', background: 'transparent', border: 'none',
                    padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.danger,
                  }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                     onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                     onClick={() => { onDelete(n); closeMenu(); }}>
                    删除
                  </button>
                  <button style={{
                    textAlign: 'left', background: 'transparent', border: 'none',
                    padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.textPrimary,
                  }} onMouseEnter={(e) => (e.currentTarget.style.background = t.bgRowHover)}
                     onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                     onClick={() => { onCopyPath(n); closeMenu(); }}>
                    复制路径
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
