// src/renderer/styles.ts
//
// 主题感知内联样式集合。每个样式函数接收当前 ThemeTokens，返回 CSSProperties。
// 避免引入 CSS 框架，保持 MVP 轻量。
import type { CSSProperties } from 'react';
import type { ThemeTokens } from './theme';

// —— 工厂函数：生成当前主题下的全部样式令牌 ——
export function createStyles(t: ThemeTokens): Record<string, CSSProperties> {
  return {
    app: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 13, background: t.bgApp, color: t.textPrimary },
    toolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${t.border}`, background: t.bgToolbar, flexShrink: 0 },
    root: { color: t.textSecondary, fontSize: 12 },
    status: { color: t.danger, fontSize: 12, marginLeft: 'auto' },
    body: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' },
    sidebar: { width: 260, borderRight: `1px solid ${t.border}`, overflow: 'auto', padding: 0, background: t.bgSidebar, display: 'flex', flexDirection: 'column' },
    // §17 可拖拽分栏
    splitter: { flex: '0 0 auto', width: 5, cursor: 'col-resize', background: t.border, margin: 0, transition: 'background 0.15s', flexShrink: 0 },
    splitterActive: { background: t.accent },
    editorArea: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: t.bgEditor, overflow: 'hidden' },
    tabBar: { display: 'flex', borderBottom: `1px solid ${t.border}`, background: t.bgTabBar, overflowX: 'auto', flexShrink: 0, minHeight: 34 },
    tab: { padding: '5px 12px', cursor: 'pointer', borderRight: `1px solid ${t.borderLight}`, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textSecondary, background: 'transparent', userSelect: 'none' },
    tabActive: { background: t.bgTabActive, color: t.textPrimary, fontWeight: 600 },
    tabClose: { color: t.textMuted, fontSize: 14, lineHeight: 1, padding: '0 2px', borderRadius: 3, cursor: 'pointer' },
    tabBarActions: { display: 'flex', alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto', padding: '0 4px', position: 'sticky', right: 0, background: t.bgTabBar, borderLeft: `1px solid ${t.borderLight}` },
    tabBarBtn: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, color: t.textSecondary, padding: '4px 8px', borderRadius: 3 },
    tabMenuDivider: { height: 1, background: t.border, margin: '4px 0' },
    hint: { padding: 20, color: t.textMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 },
    editorWrap: { position: 'relative', flex: 1, minHeight: 0 },
    errorBar: { position: 'absolute', bottom: 0, left: 0, right: 0, background: t.danger, color: '#fff', padding: '4px 10px', fontSize: 12, zIndex: 10 },
    banner: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: t.bgBanner, borderBottom: `1px solid ${t.warning}`, color: t.textPrimary, flexShrink: 0 },
    row: { padding: '3px 8px', cursor: 'pointer', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, lineHeight: '22px', position: 'relative', userSelect: 'none' },
    rowSelected: { background: t.bgRowSelected },
    rowDragOver: { background: t.bgRowHover, outline: `1px dashed ${t.accent}`, outlineOffset: -1 },
    rowDragging: { opacity: 0.45 },
    panelDragOver: { background: t.bgRowHover, outline: `1.5px dashed ${t.accent}`, outlineOffset: -3, borderRadius: 4 },

    // TRAE IDE 风格：文件树分区标题栏
    sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px 4px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: t.textMuted, userSelect: 'none', flexShrink: 0 },
    sectionTitle: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' },
    sectionToolbar: { display: 'flex', alignItems: 'center', gap: 2 },

    // TRAE 工具栏按钮
    toolbarBtn: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '3px 5px', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26 },
    toolbarBtnHover: { background: t.bgRowHover },

    modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200 },
    modalBox: { position: 'fixed', zIndex: 201, top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 8, boxShadow: t.shadowModal, padding: 20, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 14 },
    modalTitle: { fontWeight: 600, fontSize: 15, color: t.textPrimary },
    modalMsg: { fontSize: 13, color: t.textSecondary, lineHeight: 1.5 },
    modalInput: { padding: '8px 10px', fontSize: 13, border: `1px solid ${t.border}`, borderRadius: 4, background: t.bgInput, color: t.textPrimary, outline: 'none' },
    modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
    modalBtn: { padding: '7px 14px', fontSize: 13, borderRadius: 4, border: `1px solid ${t.border}`, cursor: 'pointer', background: t.bgToolbar, color: t.textPrimary },
    modalBtnPrimary: { padding: '7px 14px', fontSize: 13, borderRadius: 4, border: 'none', cursor: 'pointer', background: t.accent, color: '#fff' },

    sub: { padding: '2px 16px', color: t.textMuted, fontSize: 12 },
    err: { padding: '2px 16px', color: t.danger, fontSize: 12 },
    menuBackdrop: { position: 'fixed', inset: 0, zIndex: 100 },
    ctxMenu: { position: 'fixed', zIndex: 101, background: t.bgCtxMenu, border: `1px solid ${t.border}`, borderRadius: 6, boxShadow: t.shadowCtxMenu, padding: 4, display: 'flex', flexDirection: 'column', minWidth: 140 },
    ctxItem: { textAlign: 'left', background: 'transparent', border: 'none', padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderRadius: 4, color: t.textPrimary },

    statusBar: { display: 'flex', alignItems: 'center', gap: 16, padding: '3px 12px', borderTop: `1px solid ${t.border}`, background: t.bgStatus, fontSize: 12, color: t.textInverse, flex: '0 0 auto' },
    statusBarPath: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
    statusBarMeta: { color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' },
    statusBarFeedback: { color: '#a5d6a7', whiteSpace: 'nowrap', fontWeight: 500 },

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

    // 主题切换按钮
    themeToggle: { border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '3px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28 },
    panelToggle: { border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: t.textSecondary, padding: '3px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28 },
  };
}

// 向后兼容：导出一个默认 light 实例（App 初始渲染用，立即被主题覆盖）
import { LIGHT_THEME } from './theme';
export { LIGHT_THEME };
export const styles = createStyles(LIGHT_THEME);
