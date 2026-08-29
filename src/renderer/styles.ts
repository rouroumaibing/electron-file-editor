// src/renderer/styles.ts
// MVP 内联样式集合（避免引入 CSS 框架）。后续可迁到 CSS Modules。
import type { CSSProperties } from 'react';

export const styles: Record<string, CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif', fontSize: 13 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #ddd', background: '#f6f6f6' },
  root: { color: '#555', fontSize: 12 },
  status: { color: '#c0392b', fontSize: 12, marginLeft: 'auto' },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  sidebar: { width: 260, borderRight: '1px solid #ddd', overflow: 'auto', padding: 6, background: '#fafafa' },
  // §17 可拖拽分栏：侧栏与编辑区之间的竖向拖拽条（自由拉伸，非固定宽度）
  splitter: { flex: '0 0 auto', width: 5, cursor: 'col-resize', background: '#ddd', margin: 0, transition: 'background 0.1s' },
  splitterActive: { background: '#2b6cb0' },
  editorArea: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  tabBar: { display: 'flex', borderBottom: '1px solid #ddd', background: '#f0f0f0', overflowX: 'auto' },
  tab: { padding: '5px 10px', cursor: 'pointer', borderRight: '1px solid #ddd', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 },
  tabActive: { background: '#fff', fontWeight: 600 },
  tabClose: { color: '#999' },
  // 批量关闭页签：tab 栏右端常驻操作区（sticky 保证横向滚动时仍可见）
  tabBarActions: { display: 'flex', alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto', padding: '0 4px', position: 'sticky', right: 0, background: '#f0f0f0', borderLeft: '1px solid #ddd' },
  tabBarBtn: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, lineHeight: 1, color: '#666', padding: '3px 8px', borderRadius: 3 },
  tabMenuDivider: { height: 1, background: '#ddd', margin: '4px 0' },
  hint: { padding: 20, color: '#888' },
  editorWrap: { position: 'relative', flex: 1, minHeight: 0 },
  errorBar: { position: 'absolute', bottom: 0, left: 0, right: 0, background: '#c0392b', color: '#fff', padding: '4px 10px', fontSize: 12, zIndex: 10 },
  banner: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#fff3cd', borderBottom: '1px solid #ffc107', color: '#7a5b00' },
  row: { padding: '2px 4px', cursor: 'pointer', borderRadius: 3 },
  rowSelected: { background: '#e3f0ff' }, // §3.3 选中态高亮
  rowDragOver: { background: '#d6eaff', outline: '1px dashed #4a90d9', outlineOffset: -1 }, // §3.6c 拖拽落点高亮
  rowDragging: { opacity: 0.45 }, // §3.6c 拖拽中的源节点半透明
  panelDragOver: { background: '#eef6ff', outline: '1.5px dashed #4a90d9', outlineOffset: -3, borderRadius: 4 }, // §3.6c 树面板空白=根落点高亮
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 200 },
  modalBox: { position: 'fixed', zIndex: 201, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: '#fff', border: '1px solid #ccc', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', padding: 16, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 12 },
  modalTitle: { fontWeight: 600, fontSize: 14 },
  modalMsg: { fontSize: 13, color: '#555' },
  modalInput: { padding: '6px 8px', fontSize: 13, border: '1px solid #ccc', borderRadius: 4 },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  modalBtn: { padding: '6px 12px', fontSize: 13, borderRadius: 4, border: '1px solid #ccc', cursor: 'pointer', background: '#f6f6f6' },
  modalBtnPrimary: { padding: '6px 12px', fontSize: 13, borderRadius: 4, border: '1px solid #2b6cb0', cursor: 'pointer', background: '#2b6cb0', color: '#fff' },

  sub: { padding: '2px 4px', color: '#999', fontSize: 12 },
  err: { padding: '2px 4px', color: '#c0392b', fontSize: 12 },
  menuBackdrop: { position: 'fixed', inset: 0, zIndex: 100 },
  ctxMenu: { position: 'fixed', zIndex: 101, background: '#fff', border: '1px solid #ccc', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', padding: 4, display: 'flex', flexDirection: 'column', minWidth: 120 },
  ctxItem: { textAlign: 'left', background: 'transparent', border: 'none', padding: '6px 10px', cursor: 'pointer', fontSize: 13, borderRadius: 3 },
  // 底部状态栏：左 = 当前文件/工作区路径，右 = 编码 · 换行符（§13 编码约定）
  statusBar: { display: 'flex', alignItems: 'center', gap: 16, padding: '3px 10px', borderTop: '1px solid #ddd', background: '#f6f6f6', fontSize: 12, color: '#555', flex: '0 0 auto' },
  statusBarPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  statusBarMeta: { color: '#2b6cb0', whiteSpace: 'nowrap' },
  // 底部保存成功反馈（§7.3 改版 v2）：绿色成功态，2.5s 自动消失
  statusBarFeedback: { color: '#2f7d32', whiteSpace: 'nowrap' },
  // §3.6b 拖拽打开：系统文件/文件夹悬停窗口时的全局高亮遮罩
  dropOverlay: {
    position: 'fixed', inset: 0, zIndex: 300, pointerEvents: 'none',
    background: 'rgba(43, 108, 176, 0.10)',
    border: '3px dashed #2b6cb0',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dropOverlayBox: {
    background: '#2b6cb0', color: '#fff', padding: '10px 18px',
    borderRadius: 6, fontSize: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  },
};
