#!/usr/bin/env node
// scripts/clean.mjs
//
// 清理构建产物 / 依赖 / 运行时残留：
//   pnpm clean        -> 删除构建产物 (out/ 与 dist/) 与 dev-daemon 运行时产物目录 (log/ 与 pid/)，
//                        并清掉 electron-vite 加载 TS config 生成的临时 bundle（electron.vite.config.*.mjs）
//   pnpm clean deep   -> 在上面的基础上额外删除 node_modules/ 与 pnpm-lock.yaml（彻底重装）
//
// 设计文档 §11.1 引用。本地开发与 pnpm 工作流配套。

import { rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const deep = process.argv.includes('deep');

const normalTargets = [
  resolve(root, 'out'),
  resolve(root, 'dist'),
  resolve(root, 'log'), // dev-daemon 运行日志目录（log/dev-daemon.log）
  resolve(root, 'pid'), // dev-daemon pid 文件目录（pid/dev-daemon.pid）
];
const deepTargets = [resolve(root, 'node_modules'), resolve(root, 'pnpm-lock.yaml')];

const targets = deep ? [...normalTargets, ...deepTargets] : normalTargets;

for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true });
    console.log(`[clean] 已删除: ${t}`);
  } else {
    console.log(`[clean] 跳过(不存在): ${t}`);
  }
}

// electron-vite 5 加载 TS config 生成的临时 bundle（时间戳命名，未自清理，见 .gitignore）
for (const f of readdirSync(root)) {
  if (/^electron\.vite\.config\.\d+\.mjs$/.test(f)) {
    const p = resolve(root, f);
    rmSync(p, { force: true });
    console.log(`[clean] 已删除: ${p}`);
  }
}
