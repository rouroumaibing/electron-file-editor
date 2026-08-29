// src/renderer/settings.ts
//
// 客户端偏好（§14 自动定时保存）。仅渲染层 localStorage 持久化，不进主进程。
// 默认值：关闭自动保存、间隔 30s。

export interface AutoSaveSettings {
  autoSaveEnabled: boolean;
  autoSaveIntervalMs: number;
}

const STORAGE_KEY = 'fileEditorSettings';
const DEFAULTS: AutoSaveSettings = { autoSaveEnabled: false, autoSaveIntervalMs: 30_000 };

export function loadSettings(): AutoSaveSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AutoSaveSettings>;
    return {
      autoSaveEnabled: typeof parsed.autoSaveEnabled === 'boolean' ? parsed.autoSaveEnabled : DEFAULTS.autoSaveEnabled,
      autoSaveIntervalMs:
        typeof parsed.autoSaveIntervalMs === 'number' && parsed.autoSaveIntervalMs >= 1000
          ? parsed.autoSaveIntervalMs
          : DEFAULTS.autoSaveIntervalMs,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AutoSaveSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等场景下写入失败不阻断主流程 */
  }
}

// ── §17 分栏宽度持久化（独立 key，不与 §14 自动保存 schema 耦合）────────

const SIDEBAR_WIDTH_KEY = 'fileEditorSidebarWidth';
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_DEFAULT_WIDTH = 260;
// 与拖拽约束一致：编辑区至少留 260px
const SIDEBAR_RIGHT_RESERVE = 260;

export function loadSidebarWidth(): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH + 1, window.innerWidth - SIDEBAR_RIGHT_RESERVE);
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const w = raw === null ? NaN : parseInt(raw, 10);
    if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(Math.max(w, SIDEBAR_MIN_WIDTH), max);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    const max = Math.max(SIDEBAR_MIN_WIDTH + 1, window.innerWidth - SIDEBAR_RIGHT_RESERVE);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max)));
  } catch {
    /* 写入失败不阻断主流程 */
  }
}
