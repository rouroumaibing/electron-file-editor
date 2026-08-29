// src/renderer/modelRegistry.ts
//
// 文档 §14 明确要求：多标签场景下每个标签对应一个 monaco model，
// “关闭标签必须 model.dispose()”，且“复用同一 uri 的 Model 避免重复创建”。
// 这里以 filePath 为键维护全局 model 表（与 CodeEditor 中 model 的
// uri = file://<filePath> 对应）。切换标签时复用已有 model（保留未保存编辑），
// 关闭标签时 dispose，避免内存泄漏 / 重复创建。

import type * as Monaco from 'monaco-editor';
import type { Eol } from '@shared/types/fs';

const models = new Map<string, Monaco.editor.ITextModel>();

// §13 底部状态栏 meta（编码 · 换行符）：随 model 注册表一起维护。
// 打开文件（readFile）成功时写入；关闭标签（disposeModel）时清除。
// CodeEditor 的 model 复用分支不读盘，需从本表补报 meta，
// 否则 openFile 清空的 activeMeta 会永远停在 null（状态栏卡"读取中…"）。
export interface ModelMeta {
  encoding: string;
  eol: Eol;
}

const modelMeta = new Map<string, ModelMeta>();

export function setModelMeta(filePath: string, meta: ModelMeta): void {
  modelMeta.set(filePath, meta);
}

export function getModelMeta(filePath: string): ModelMeta | null {
  return modelMeta.get(filePath) ?? null;
}

export function getOrCreateModel(
  monaco: typeof Monaco,
  filePath: string,
  content: string,
  language: string,
): Monaco.editor.ITextModel {
  const existing = models.get(filePath);
  if (existing && !existing.isDisposed()) return existing;
  const uri = monaco.Uri.parse(`file://${filePath}`);
  const model = monaco.editor.createModel(content, language, uri);
  models.set(filePath, model);
  return model;
}

export function hasModel(filePath: string): boolean {
  const m = models.get(filePath);
  return !!m && !m.isDisposed();
}

// 取已存在的 model（不创建）。关闭保存 / 自动保存需读各 dirty tab 的最新内容，
// 非活动标签的 model 仍被本表保留（切换标签只换 setModel，不销毁），故可直接取。
export function getModel(filePath: string): Monaco.editor.ITextModel | null {
  const m = models.get(filePath);
  return m && !m.isDisposed() ? m : null;
}

export function disposeModel(filePath: string): void {
  const model = models.get(filePath);
  if (model && !model.isDisposed()) model.dispose();
  models.delete(filePath);
  modelMeta.delete(filePath); // meta 与 model 同生命周期
}
