#!/usr/bin/env node
// scripts/clean.mjs
//
// 清理构建产物 / 依赖 / 运行时残留：
//   pnpm clean        -> 删除构建产物 (out/ 与 dist/) 与 dev-daemon 运行时产物目录 (log/ 与 pid/)，
//                        并清掉 electron-vite 加载 TS config 生成的临时 bundle（electron.vite.config.*.mjs）
//   pnpm clean deep   -> 在上面的基础上额外删除 node_modules/（彻底重装依赖）
//
// 注意：deep 不删除 pnpm-lock.yaml——本仓库 .gitignore 明确提交锁文件以保证
// 可复现安装，且 CI 用 `pnpm install --frozen-lockfile`。删锁文件会让 CI 的
// setup-node 缓存查找失败、frozen install 硬失败。需要重置依赖树时只清 node_modules，
// 让 `pnpm install` 依据既有 lockfile 重建。
//
// 设计文档 §13.1 脚本矩阵 引用。本地开发与 pnpm 工作流配套。

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
// deep 只清 node_modules（保留 pnpm-lock.yaml，见文件头说明）
const deepTargets = [resolve(root, 'node_modules')];

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
