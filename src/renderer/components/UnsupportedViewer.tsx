// src/renderer/components/UnsupportedViewer.tsx
//
// "暂不支持浏览"整页提示（§13）：pdf/docx 等二进制文件、超大文件、或读取失败时，
// 在显示区中央渲染友好提示页，而不是落到编辑器底部红字错误条。
// 与 CodeEditor 的错误条职责区分：这里是类型/大小层面的静态提示，不是操作错误。
import { styles } from '../styles';
import type { ThemeMode } from '../theme';

interface Props {
  filePath: string;
  message?: string; // 类型/大小层面的补充说明
  error?: string; // 读取失败等真实错误的可读信息（可选）
  themeMode: ThemeMode;
}

export function UnsupportedViewer({ filePath, message, error, themeMode }: Props) {
  const name = filePath.split('/').pop() || filePath;
  const isDark = themeMode === 'dark';
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        minHeight: 0,
        background: isDark ? '#1e1e1e' : '#ffffff',
      }}
    >
      <div style={{ fontSize: 44, opacity: 0.35, lineHeight: 1 }}>📄</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: isDark ? '#cccccc' : '#444' }}>{error ? '打开失败' : '暂不支持浏览'}</div>
      <div style={{ fontSize: 12, color: isDark ? '#858585' : '#888', maxWidth: 480, textAlign: 'center', wordBreak: 'break-all' }}>
        {name}
        {message && !error ? ` · ${message}` : ''}
      </div>
      {error && <div style={styles.err}>{error}</div>}
    </div>
  );
}
