// src/renderer/components/CodeEditor.tsx
//
// Monaco 集成。关键点（均对照设计文档）：
//   - §13.5 EOL 闭环：readFile 返回 eol，加载时立即 model.setEOL，保存直接写 model.getValue()
//     （model 已按选定 EOL 归一化，writeFile 不再做换行符转换）
//   - §14 提醒②：filePath 快速切换时 latest-guard，丢弃过期响应
//   - §14 提醒③：用 model 管理内容，切文件靠 key 重挂载换 model，不直接改受控 value
//   - §3.4 Cmd/Ctrl+S 保存（Monaco KeyMod.CtrlCmd 自动映射）
//
// 注意：Monaco 已在 src/renderer/monacoSetup.ts 中配置为本地打包（§14 B2），
// 经 loader.config({ monaco }) 与 web worker 接管，完全离线可用，不依赖 CDN。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { detectLanguage } from '../utils/lang';
import { useFileAPI } from '../hooks/useFileAPI';
import { getModelMeta, getOrCreateModel, hasModel, setModelMeta } from '../modelRegistry';
import type { Eol } from '@shared/types/fs';
import { styles } from '../styles';

interface Props {
  filePath: string;
  onDirtyChange: (dirty: boolean) => void;
  reloadSignal?: { path: string; nonce: number } | null;
  // 加载成功后上报编码与换行符（供底部状态栏展示；仅读盘时触发）
  onMeta?: (meta: { encoding: string; eol: Eol }) => void;
  // 保存成功回调（Cmd/Ctrl+S 或编辑器内保存触发；供底部"保存成功"反馈，§7.3 v2）
  onSaved?: () => void;
}

// 暴露给工具栏"回退/前进"按钮的命令式句柄（§14 会话内撤销/重做）
export interface CodeEditorHandle {
  undo: () => void;
  redo: () => void;
}

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { filePath, onDirtyChange, reloadSignal, onMeta, onSaved }: Props,
  ref,
) {
  const api = useFileAPI();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const reqId = useRef(0);
  const loadingRef = useRef(false);
  const saveRef = useRef<() => void>(() => {});
  // onDirtyChange / onMeta / onSaved 由 App 以箭头函数内联传入（每次渲染新建），不能进加载
  // effect 的依赖数组——否则 App 任意一次重渲染都会使加载 effect 重跑（++reqId），
  // 正在进行的 readFile 响应被 latest-guard 丢弃，表现为状态栏永久"读取中…"。
  // 统一经 ref 调用：effect 只需关心真正触发重载的信号（filePath/ready/reload）。
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onMetaRef = useRef(onMeta);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
    onMetaRef.current = onMeta;
    onSavedRef.current = onSaved;
  });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 内容变化订阅：跟随 model 切换重建（复用/读盘分支 setModel 后调用），
  // 不依赖 onDirtyChange 的引用稳定性（App 内联箭头函数每次渲染新建）。
  // model 由 modelRegistry 持有生命周期，组件卸载只需 dispose 订阅本身。
  const contentSubRef = useRef<Monaco.IDisposable | null>(null);
  const subscribeContent = useCallback(() => {
    contentSubRef.current?.dispose();
    contentSubRef.current = null;
    const model = modelRef.current;
    if (!model) return;
    contentSubRef.current = model.onDidChangeContent(() => {
      if (loadingRef.current) return; // 加载期间（setValue/setEOL）不标记 dirty
      onDirtyChangeRef.current(true);
    });
  }, []);

  // 初始化 monaco（一次）
  useEffect(() => {
    let disposed = false;
    loader.init().then((monaco) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = monaco;
      const ed = monaco.editor.create(containerRef.current, {
        automaticLayout: true,
        theme: 'vs',
      });
      editorRef.current = ed;
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveRef.current();
      });
      setReady(true);
    });
    return () => {
      disposed = true;
      contentSubRef.current?.dispose();
      contentSubRef.current = null;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  // 加载文件内容（切换文件 或 外部 reload 信号 触发）
  // 文档 §14：model 按 filePath 复用，切换标签时保留未保存编辑；
  // 仅“首次打开”或“针对本文件的强制 reload”才读磁盘覆盖。
  useEffect(() => {
    if (!ready) return;
    const id = ++reqId.current;
    let cancelled = false;
    const monaco = monacoRef.current;
    const ed = editorRef.current;
    if (!monaco || !ed) return;

    const lang = detectLanguage(filePath);
    const forceReload = reloadSignal?.path === filePath;

    // 复用已有 model（保留未保存编辑），不读磁盘、不重置 dirty
    if (!forceReload && hasModel(filePath)) {
      const model = getOrCreateModel(monaco, filePath, '', lang);
      ed.setModel(model);
      modelRef.current = model;
      subscribeContent(); // 订阅跟随新 model
      setError(null);
      // 复用分支不读盘：meta 从注册表补报。App 的 openFile 会清空 activeMeta 等
      // CodeEditor 上报，若不补报则状态栏永远停在"读取中…"（§13 状态栏契约）。
      const meta = getModelMeta(filePath);
      if (meta) onMetaRef.current?.(meta);
      return () => {
        cancelled = true;
      };
    }

    loadingRef.current = true;
    (async () => {
      try {
        const res = await api.readFile(filePath);
        if (cancelled || id !== reqId.current) return; // §14 提醒② latest-guard
        const model = getOrCreateModel(monaco, filePath, res.content, lang);
        model.setValue(res.content);
        // §13.5：在用户编辑之前立即 setEOL（EndOfLineSequence：LF=0, CRLF=1）
        const eolSeq =
          res.eol === 'CRLF'
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF;
        model.setEOL(eolSeq);
        ed.setModel(model);
        modelRef.current = model;
        subscribeContent(); // 订阅跟随新 model
        onDirtyChangeRef.current(false); // 首次打开 / 强制 reload：视为干净
        setModelMeta(filePath, { encoding: res.encoding, eol: res.eol }); // 供复用分支补报
        onMetaRef.current?.({ encoding: res.encoding, eol: res.eol }); // 底部状态栏展示
        setError(null);
      } catch (e) {
        if (cancelled || id !== reqId.current) return;
        setError((e as { message?: string }).message ?? '读取失败');
      } finally {
        if (!cancelled && id === reqId.current) loadingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
    // 注意：依赖数组刻意不含 onDirtyChange / onMeta（内联箭头函数每次渲染新建，
    // 若纳入会让读盘 effect 反复重跑、响应被 latest-guard 丢弃——状态栏卡"读取中…"）。
    // 二者经 ref 调用（见 onDirtyChangeRef/onMetaRef）；内容订阅由 subscribeContent 跟随
    // model 重建；reloadSignal 仅当针对本文件时生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, ready, reloadSignal?.nonce, api]);

  const handleSave = useCallback(async () => {
    const model = modelRef.current;
    if (!model) return;
    const content = model.getValue(); // 已按 model EOL 归一化（§13.5）
    try {
      // §7.3（改版）：本应用内的保存 = 用户主动覆盖写盘（force:true）。
      // 不做乐观并发拦截——用户在浏览区编辑后保存，保存文件即可；外部改动
      // 的可见性由 App 的非阻塞提示条承担（§8.2），不再因 mtime 变化拒绝保存。
      await api.writeFile(filePath, content, { force: true });
      onDirtyChangeRef.current(false);
      onSavedRef.current?.(); // §7.3 v2：底部"保存成功"反馈（Cmd+S / 编辑器内保存）
      setError(null);
    } catch (e) {
      const err = e as { code?: string; message: string };
      setError(err.message ?? '保存失败');
    }
  }, [api, filePath]);

  useEffect(() => {
    saveRef.current = handleSave;
  }, [handleSave]);

  // §14 会话内撤销/重做：暴露给工具栏按钮（Monaco 自身已维护 per-model 撤销栈，
  // 切换标签只换 setModel 不销毁，故跨标签的撤销历史自然保留）。
  useImperativeHandle(
    ref,
    () => ({
      undo: () => editorRef.current?.trigger('keyboard', 'undo', null),
      redo: () => editorRef.current?.trigger('keyboard', 'redo', null),
    }),
    [],
  );

  return (
    <div style={styles.editorWrap}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {error && <div style={styles.errorBar}>{error}</div>}
    </div>
  );
});
