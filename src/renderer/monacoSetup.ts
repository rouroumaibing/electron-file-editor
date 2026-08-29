// src/renderer/monacoSetup.ts
//
// Monaco 离线化（设计文档 §7.1）：默认 @monaco-editor/react 的 loader 从 CDN
// 下载 monaco 运行时，断网 / 三端分发场景下不可靠（编辑器直接白屏）。此处改用
// 本地打包的 monaco-editor，并配置 web worker，使编辑器完全离线可用。
//
// ⚠️ 必须在任何 loader.init() 之前执行（见 main.tsx 顶部 import）。
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// monaco 0.53+ 的 package.json 引入 exports 映射（"./*" -> "./esm/vs/*.js"），
// 导入路径去掉 esm/vs/ 前缀但保留子目录（editor/、language/...）：
// "monaco-editor/editor/editor.worker" -> esm/vs/editor/editor.worker.js
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// 注：monaco-editor 的类型已声明全局 `MonacoEnvironment`，此处直接赋值即可。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 用本地 monaco 替代 CDN loader：loader.init() 检测到已 config(monaco) 时跳过 CDN 下载
loader.config({ monaco });

export {};
