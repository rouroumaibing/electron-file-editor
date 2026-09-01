// src/renderer/components/FilePreviewGate.tsx
//
// 非图片文件的预览路由门：打开前先 probeFile，按类别分流——
//   text   -> Monaco 文本编辑器（renderEditor）
//   binary -> "暂不支持浏览"提示页（pdf/docx 等，不再走 CodeEditor 底部红字）
//   large  -> "文件过大"提示页
//   error  -> 打开失败提示页（E_NOENT 等真实错误）
//
// 预检与 CodeEditor 内部的 readFile 会各 probe 一次，本地文件系统开销可忽略，
// 换来的是路由准确性（避免二进制内容被塞进 Monaco）。
import { useEffect, useState, type ReactNode } from 'react';
import { useFileAPI } from '../hooks/useFileAPI';
import { styles } from '../styles';
import { UnsupportedViewer } from './UnsupportedViewer';
import type { ThemeMode } from '../theme';

interface Props {
  filePath: string;
  renderEditor: (filePath: string) => ReactNode;
  themeMode: ThemeMode;
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'text' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };

export function FilePreviewGate({ filePath, renderEditor, themeMode }: Props) {
  const api = useFileAPI();
  // 初始 state 即 checking；App 侧以 key={filePath} 重挂载本组件来重置（切文件即新实例），
  // 不再在 effect 内同步 setState——避免 effect 依赖变化时触发渲染循环
  // （曾出现 "Maximum update depth exceeded"：api 引用变化 → effect 重跑 → 同步
  // setState(checking) → 重渲染 → 循环，React 冻结 UI，状态栏永久"读取中…"）。
  const [state, setState] = useState<GateState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const probe = await api.probeFile(filePath);
        if (cancelled) return;
        if (probe.category === 'text') setState({ kind: 'text' });
        else if (probe.category === 'large') setState({ kind: 'unsupported', message: '文件过大，暂不支持浏览' });
        else setState({ kind: 'unsupported', message: '暂不支持浏览该文件类型' });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: (e as { message?: string }).message ?? '读取失败' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, filePath]);

  if (state.kind === 'checking') return <div style={styles.hint}>检查文件…</div>;
  if (state.kind === 'text') return <>{renderEditor(filePath)}</>;
  return (
    <UnsupportedViewer
      filePath={filePath}
      message={state.kind === 'unsupported' ? state.message : undefined}
      error={state.kind === 'error' ? state.message : undefined}
      themeMode={themeMode}
    />
  );
}
