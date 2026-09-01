// src/renderer/theme.ts
//
// 主题系统：暗色(dark) / 亮色(light) 双主题，基于 CSS 变量。
// 偏好持久化到 localStorage，默认跟随系统 prefers-color-scheme。
// TRAE IDE 风格配色方案。

export type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'fileEditorTheme';
const PANEL_POS_KEY = 'fileEditorPanelPosition';

export type PanelPosition = 'left' | 'right';

// —— TRAE IDE 风格配色令牌 ——
export interface ThemeTokens {
  // 背景
  bgApp: string;
  bgToolbar: string;
  bgSidebar: string;
  bgEditor: string;
  bgTabBar: string;
  bgTabActive: string;
  bgRowHover: string;
  bgRowSelected: string;
  bgModal: string;
  bgCtxMenu: string;
  bgStatus: string;
  bgBanner: string;
  bgInput: string;
  // 文字
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  // 边框
  border: string;
  borderLight: string;
  // 强调色
  accent: string;
  accentHover: string;
  danger: string;
  success: string;
  warning: string;
  // 文件类型颜色（TRAE 风格）
  folderColor: string;       // 目录名 - 绿色
  markdownColor: string;     // .md - 橙黄
  codeColor: string;         // .ts/.js/.tsx/.jsx - 蓝色
  configColor: string;       // .json/.yml/.yaml - 黄色
  licenseColor: string;      // LICENSE - 紫红/品红
  imageColor: string;        // 图片文件 - 青色
  defaultColor: string;      // 其他文件 - 默认文字色
  // Git 状态
  gitModified: string;       // M - 橙黄
  gitAdded: string;          // A - 绿
  gitDeleted: string;        // D - 红
  gitUntracked: string;      // U - 绿
  gitConflict: string;       // C - 红
  // 状态指示点
  dotClean: string;          // 干净目录 - 绿
  // 阴影
  shadowModal: string;
  shadowCtxMenu: string;
}

export const DARK_THEME: ThemeTokens = {
  bgApp: '#1e1e1e',
  bgToolbar: '#252526',
  bgSidebar: '#1e1e1e',
  bgEditor: '#1e1e1e',
  bgTabBar: '#252526',
  bgTabActive: '#1e1e1e',
  bgRowHover: '#2a2d2e',
  bgRowSelected: '#094771',
  bgModal: '#2d2d30',
  bgCtxMenu: '#3c3c3c',
  bgStatus: '#007acc',
  bgBanner: '#4d3a0a',
  bgInput: '#3c3c3c',
  textPrimary: '#cccccc',
  textSecondary: '#858585',
  textMuted: '#6e6e6e',
  textInverse: '#ffffff',
  border: '#3c3c3c',
  borderLight: '#2b2b2b',
  accent: '#0e639c',
  accentHover: '#1177bb',
  danger: '#f14c4c',
  success: '#73c991',
  warning: '#e2c08d',
  folderColor: '#dcb67a',       // TRAE 暗色: 金黄色目录
  markdownColor: '#e2c08d',     // TRAE: 橙黄
  codeColor: '#75beff',         // 蓝
  configColor: '#e2c08d',       // 黄
  licenseColor: '#c586c0',      // TRAE: 紫/品红
  imageColor: '#4ec9b0',        // 青
  defaultColor: '#cccccc',      // 默认
  gitModified: '#e2c08d',
  gitAdded: '#73c991',
  gitDeleted: '#f14c4c',
  gitUntracked: '#73c991',
  gitConflict: '#f14c4c',
  dotClean: '#73c991',
  shadowModal: '0 8px 32px rgba(0,0,0,0.5)',
  shadowCtxMenu: '0 4px 16px rgba(0,0,0,0.3)',
};

export const LIGHT_THEME: ThemeTokens = {
  bgApp: '#ffffff',
  bgToolbar: '#f6f6f6',
  bgSidebar: '#fafafa',
  bgEditor: '#ffffff',
  bgTabBar: '#f0f0f0',
  bgTabActive: '#ffffff',
  bgRowHover: '#e8e8e8',
  bgRowSelected: '#e3f0ff',
  bgModal: '#ffffff',
  bgCtxMenu: '#ffffff',
  bgStatus: '#f6f6f6',
  bgBanner: '#fff3cd',
  bgInput: '#ffffff',
  textPrimary: '#333333',
  textSecondary: '#666666',
  textMuted: '#999999',
  textInverse: '#ffffff',
  border: '#ddd',
  borderLight: '#eee',
  accent: '#2b6cb0',
  accentHover: '#1a5290',
  danger: '#c0392b',
  success: '#27ae60',
  warning: '#f39c12',
  folderColor: '#dcb67a',       // TRAE 亮色: 保持金棕
  markdownColor: '#d97706',     // TRAE 亮色: 深橙
  codeColor: '#2563eb',         // 蓝
  configColor: '#ca8a04',       // 黄
  licenseColor: '#a855f7',      // TRAE 亮色: 亮紫
  imageColor: '#0891b2',        // 青蓝
  defaultColor: '#333333',
  gitModified: '#d97706',
  gitAdded: '#16a34a',
  gitDeleted: '#dc2626',
  gitUntracked: '#16a34a',
  gitConflict: '#dc2626',
  dotClean: '#16a34a',
  shadowModal: '0 8px 32px rgba(0,0,0,0.15)',
  shadowCtxMenu: '0 2px 8px rgba(0,0,0,0.12)',
};

// —— 文件扩展名 -> 颜色映射 ——
const EXT_COLOR_MAP: Record<string, keyof ThemeTokens> = {
  '.md': 'markdownColor',
  '.mdx': 'markdownColor',
  '.markdown': 'markdownColor',
  '.ts': 'codeColor',
  '.tsx': 'codeColor',
  '.js': 'codeColor',
  '.jsx': 'codeColor',
  '.mjs': 'codeColor',
  '.cjs': 'codeColor',
  '.json': 'configColor',
  '.yml': 'configColor',
  '.yaml': 'configColor',
  '.toml': 'configColor',
  '.xml': 'configColor',
  '.html': 'codeColor',
  '.htm': 'codeColor',
  '.css': 'codeColor',
  '.scss': 'codeColor',
  '.less': 'codeColor',
  '.vue': 'codeColor',
  '.svelte': 'codeColor',
  '.py': 'codeColor',
  '.go': 'codeColor',
  '.rs': 'codeColor',
  '.java': 'codeColor',
  '.sh': 'codeColor',
  '.bash': 'codeColor',
  '.zsh': 'codeColor',
  '.png': 'imageColor',
  '.jpg': 'imageColor',
  '.jpeg': 'imageColor',
  '.gif': 'imageColor',
  '.webp': 'imageColor',
  '.svg': 'imageColor',
  '.bmp': 'imageColor',
  '.ico': 'imageColor',
};

// 特殊文件名（无扩展名或特殊含义）
const SPECIAL_FILE_COLOR_MAP: Record<string, keyof ThemeTokens> = {
  'license': 'licenseColor',
  'licence': 'licenseColor',
  'readme': 'markdownColor',
  'changelog': 'markdownColor',
  'contributing': 'markdownColor',
  'makefile': 'configColor',
  'dockerfile': 'configColor',
  '.gitignore': 'configColor',
  '.dockerignore': 'configColor',
  '.eslintrc': 'configColor',
  '.prettierrc': 'configColor',
  '.editorconfig': 'configColor',
  'tsconfig.json': 'configColor',
  'package.json': 'configColor',
  '.env': 'configColor',
  '.env.example': 'configColor',
};

/** 根据文件名取颜色 token key */
export function getFileColorToken(name: string): keyof ThemeTokens {
  const lower = name.toLowerCase();
  // 特殊文件名优先
  if (SPECIAL_FILE_COLOR_MAP[lower]) return SPECIAL_FILE_COLOR_MAP[lower];
  // 扩展名匹配
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = lower.slice(dotIdx);
    if (EXT_COLOR_MAP[ext]) return EXT_COLOR_MAP[ext];
  }
  return 'defaultColor';
}

/** 检测系统偏好主题 */
function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 加载主题偏好 */
export function loadTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
  } catch { /* ignore */ }
  return getSystemTheme();
}

/** 保存主题偏好 */
export function saveTheme(mode: ThemeMode): void {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
}

/** 加载面板位置偏好 */
export function loadPanelPosition(): PanelPosition {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (raw === 'left' || raw === 'right') return raw;
  } catch { /* ignore */ }
  return 'left';
}

/** 保存面板位置偏好 */
export function savePanelPosition(pos: PanelPosition): void {
  try { localStorage.setItem(PANEL_POS_KEY, pos); } catch { /* ignore */ }
}
