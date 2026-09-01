// src/renderer/components/ImageViewer.tsx
//
// 图片预览分支（§13.6）。点击图片文件（isImage 命中）时由 App 路由到此组件，
// 经 fileAPI.readImage 取得 base64 data URL 后以 <img> 展示，不进 Monaco。
import { useEffect, useState } from 'react';
import { useFileAPI } from '../hooks/useFileAPI';
import { styles } from '../styles';
import type { ThemeMode } from '../theme';

export function ImageViewer({ filePath, themeMode }: { filePath: string; themeMode: ThemeMode }) {
  const api = useFileAPI();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 加载状态由 App 侧 key={filePath} 重挂载重置（初始 state 即 null），
    // 不再 effect 内同步 setState（react-hooks/set-state-in-effect）
    (async () => {
      try {
        const { dataUrl } = await api.readImage(filePath);
        if (!cancelled) setDataUrl(dataUrl);
      } catch (e) {
        if (!cancelled) setError((e as { message?: string }).message ?? '图片读取失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, filePath]);

  if (error) return <div style={styles.errorBar}>{error}</div>;
  if (!dataUrl) return <div style={styles.hint}>加载图片…</div>;
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, background: themeMode === 'dark' ? '#1e1e1e' : '#ffffff', minHeight: 0 }}>
      <img
        src={dataUrl}
        alt={filePath}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    </div>
  );
}
