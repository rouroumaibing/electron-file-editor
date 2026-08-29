#!/usr/bin/env node
// scripts/dev-daemon.mjs
//
// pnpm 启动守护：在前台或后台运行 electron-vite dev。
//
//   pnpm start            -> 前台运行（等价于旧 `npm run dev`，终端被占用）
//   pnpm start --daemon   -> 后台运行：日志写 log/dev-daemon.log，PID 写 pid/dev-daemon.pid
//   pnpm stop             -> 停止本服务的所有相关进程（pid 文件 + 进程名扫描 + 端口探测）
//   pnpm status           -> 查询当前运行状态（pid 文件是否有效 / 存活进程 / 端口占用）
//
// 后台模式内部结构（两层）：
//   `start --daemon` spawn 一个**常驻 supervisor**（`node dev-daemon.mjs run`，detached），
//   supervisor 再拉起 electron-vite。pid 文件由 supervisor 持有：
//   - electron-vite 正常退出（如用户点窗口关闭）→ supervisor 自动清理 pid 文件后退出，
//     杜绝"窗口关了但 pid 文件残留"的孤儿文件；
//   - supervisor 是独立进程组组长，`pnpm stop` 杀该进程组即可整树带走。
//
// 进程识别（三重判定，避免纯 pid 文件的盲区）：
//   1. pid 文件：存活且其命令行确实属于本项目才认（防 pid 被复用误杀他人进程）。
//   2. 进程名扫描：ps 全表匹配本项目 root 下的 electron-vite / electron 运行路径
//      —— 覆盖"pid 文件没写成但进程还活着"的孤儿场景。
//   3. 端口探测：lsof 检查 dev server 端口（默认 5173），属于本服务的进程一并纳入；
//      被无关进程占用则拒绝启动，绝不误杀。
//
// 注意：刻意剥离 ELECTRON_RUN_AS_NODE 再启动，避免该环境变量残留导致
// electron 以纯 Node 模式启动而崩溃（见设计文档 §3.2 / electron-vite 陷阱）。

import { spawn, execFileSync } from 'node:child_process';
import { openSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
// 运行产物收进专用目录（pid/ + log/），不再散落项目根目录。
// 目录随脚本幂等创建（stop/status 触发也安全）；clean 按整目录清理，见设计文档 §11。
const pidFile = resolve(root, 'pid', 'dev-daemon.pid');
const logFile = resolve(root, 'log', 'dev-daemon.log');
mkdirSync(dirname(pidFile), { recursive: true });
mkdirSync(dirname(logFile), { recursive: true });

// dev server 端口（与 electron.vite.config.ts 默认一致；可用 DEV_PORT 覆盖）
const DEV_PORT = Number(process.env.DEV_PORT) || 5173;

// 剥离会让 electron 崩溃的环境变量（见上）
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// 返回待执行的命令与参数。
// 关键：不能 spawn node_modules/.bin/electron-vite —— 那是个 shell 包装脚本
// （POSIX 是 /bin/sh、Windows 是 .cmd），用 node 当 JS 跑会直接 SyntaxError。
// 必须指向包内真实 JS 入口 node_modules/electron-vite/bin/electron-vite.js。
function commandFor() {
  const bin = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js');
  return { cmd: process.execPath, args: [bin, 'dev'], shell: false };
}

// ── 进程探测 ──────────────────────────────────────────────────────────

// 进程命令行是否属于本服务（本项目 root 下运行的 electron-vite / electron）
// 关键：pnpm 用符号链接布局，Electron 进程的命令行是 Node 解析后的**真实路径**
// （如 `${root}/node_modules/.pnpm/electron@44.0.0/node_modules/electron/dist/...`），
// 不能用 `${root}/node_modules/electron/dist/` 这种带 root 前缀的字面匹配（会漏）。
// 改为：命令行含本项目 root（归属判定）+ 含无前缀的包路径子串（身份判定），
// npm / pnpm 两种布局都覆盖。
function isOurs(commandLine) {
  if (!commandLine || !commandLine.includes(root)) return false;
  // 本脚本自身的 supervisor 进程（命令行形如 `node <root>/scripts/dev-daemon.mjs run`）。
  // 用 `dev-daemon.mjs run` 而非裸文件名匹配：避免误伤"编辑器恰好打开了这个脚本文件"之类的进程。
  if (commandLine.includes('dev-daemon.mjs run')) return true;
  return (
    commandLine.includes('node_modules/electron-vite/') ||
    commandLine.includes('node_modules/electron/dist/')
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // 信号 0 仅探测存活
    return true;
  } catch {
    return false;
  }
}

// 读取 pid 文件（缺失/内容非法返回 null）
function readPidFile() {
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// 清理 pid 文件——仅当内容仍是 pid 本人时才删，避免误删更新实例刚写入的文件
function removePidFileIfOwn(pid) {
  if (!existsSync(pidFile)) return;
  if (readPidFile() === pid) {
    try {
      unlinkSync(pidFile);
    } catch {
      /* 已被并发清理 */
    }
  }
}

// 读取进程的完整命令行（macOS/Linux 通用走 ps；-ww 防止长命令行被截断——
// 截断会导致 electron 的完整路径匹配不上 isOurs，曾造成 stop 杀不掉窗口）
function commandOf(pid) {
  try {
    const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).trim();
    return out;
  } catch {
    return '';
  }
}

// 全表扫描：[{ pid, command }]（-ww 不限输出宽度，防长路径截断漏匹配）
function scanProcesses() {
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return out
      .split('\n')
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), command: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 占用 dev server 端口的 pid 列表（lsof 不可用/无监听时返回 []）
function portListeners(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return []; // 无监听或 lsof 失败，按无占用处理
  }
}

// 汇总本服务所有实例（去重）：pid 文件 + 进程名扫描 + 端口探测
function findInstances() {
  const map = new Map(); // pid -> command

  // 1) pid 文件：要求存活且命令行确属本服务（防 pid 复用）
  const pidInFile = readPidFile();
  if (pidInFile !== null && isAlive(pidInFile)) {
    const cmd = commandOf(pidInFile);
    if (isOurs(cmd)) map.set(pidInFile, cmd);
    else console.warn(`[dev-daemon] pid 文件中的 ${pidInFile} 不属于本服务（可能已被复用），忽略。`);
  }

  // 2) 进程名扫描：抓孤儿进程（pid 文件缺失但进程还活着）
  for (const { pid, command } of scanProcesses()) {
    if (pid !== process.pid && isOurs(command)) map.set(pid, command);
  }

  // 3) 端口探测：dev server 端口上的监听者若属本服务则纳入
  for (const pid of portListeners(DEV_PORT)) {
    if (pid !== process.pid && isAlive(pid)) {
      const cmd = commandOf(pid);
      if (isOurs(cmd)) map.set(pid, cmd);
    }
  }

  return [...map.entries()].map(([pid, command]) => ({ pid, command }));
}

// 端口被"非本服务"进程占用时返回其 pid（用于 start 前拒绝启动）
function findForeignPortOwner() {
  for (const pid of portListeners(DEV_PORT)) {
    if (pid === process.pid) continue;
    if (!isOurs(commandOf(pid))) return { pid, command: commandOf(pid) };
  }
  return null;
}

// ── 停止 ──────────────────────────────────────────────────────────────

function stopInstances(instances) {
  for (const { pid } of instances) {
    try {
      process.kill(-pid, 'SIGTERM'); // 先试进程组（electron 子进程一并带走）
    } catch {
      /* 非组长或已退出 */
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 可能已退出 */
    }
  }
  // 最多等 3s，未退出的强杀
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const alive = instances.filter(({ pid }) => isAlive(pid));
    if (alive.length === 0) break;
    sleepMs(200);
  }
  for (const { pid } of instances) {
    if (isAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      console.warn(`[dev-daemon] pid=${pid} 未响应 SIGTERM，已强杀。`);
    }
  }
  // 终检：稍等内核回收，再重新扫描；若仍有本服务进程（如孤儿化的
  // electron 主/助手进程）则逐个强杀
  sleepMs(500);
  const survivors = findInstances();
  for (const { pid } of survivors) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    console.warn(`[dev-daemon] 终检发现残留 pid=${pid}，已强杀。`);
  }
}

function sleepMs(ms) {
  // 主线程同步阻塞（守护脚本无并发需求，Atomics.wait 足够）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopDaemon() {
  const instances = findInstances();
  if (instances.length === 0) {
    if (existsSync(pidFile)) unlinkSync(pidFile); // 顺手清残留
    console.error('[dev-daemon] 未发现本服务相关进程（已按 pid/进程名/端口三重检查）。');
    process.exit(0);
  }
  console.log(`[dev-daemon] 发现本服务进程 ${instances.length} 个：`);
  for (const { pid, command } of instances) {
    console.log(`  - pid=${pid}  ${command.slice(0, 120)}`);
  }
  stopInstances(instances);
  if (existsSync(pidFile)) unlinkSync(pidFile);
  console.log('[dev-daemon] 已全部停止。');
}

// ── 启动 ──────────────────────────────────────────────────────────────

// start 前置检查：若本服务已在运行则先停止；端口被无关进程占用则拒绝
function preflight() {
  const instances = findInstances();
  if (instances.length > 0) {
    console.log(`[dev-daemon] 检测到本服务已在运行（${instances.length} 个进程），先停止：`);
    for (const { pid, command } of instances) {
      console.log(`  - pid=${pid}  ${command.slice(0, 120)}`);
    }
    stopInstances(instances);
    console.log('[dev-daemon] 旧实例已停止。');
  }
  if (existsSync(pidFile)) unlinkSync(pidFile);

  const foreign = findForeignPortOwner();
  if (foreign) {
    console.error(
      `[dev-daemon] 端口 ${DEV_PORT} 被无关进程占用，拒绝启动：\n  pid=${foreign.pid}  ${foreign.command.slice(0, 120)}\n` +
        `  请先处理该进程，或用 DEV_PORT=<其他端口> pnpm start --daemon 更换端口。`,
    );
    process.exit(1);
  }
}

function startDaemon() {
  preflight();
  const logFd = openSync(logFile, 'a');
  // spawn 常驻 supervisor（本脚本 run 模式），由它拉起 electron-vite 并持有 pid 文件。
  // detached: true → supervisor 成为新进程组组长，stop 时 kill(-pid) 整树带走。
  const child = spawn(process.execPath, [__filename, 'run'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: cleanEnv(),
  });
  child.on('error', (err) => {
    console.error('[dev-daemon] 启动失败:', err.message);
    process.exit(1);
  });
  // 立即写 pid 文件（与 supervisor 启动后自写的一致，双保险覆盖启动间隙）
  writeFileSync(pidFile, String(child.pid), 'utf8');
  console.log(`[dev-daemon] 已在后台启动 (pid=${child.pid})。日志: ${logFile}`);
  console.log('[dev-daemon] 用 `pnpm status` 查看运行状态；关闭窗口或 `pnpm stop` 后 pid 文件自动清理。');
  child.unref();
  process.exit(0);
}

// ── run：常驻 supervisor（后台模式内部使用） ─────────────────────────
// 由 `start --daemon` detached 拉起。职责：
//   1. 持有 pid 文件（写入自身 pid；它是新进程组组长，stop 杀组即整树带走）。
//   2. 盯住 electron-vite：子进程退出（如用户点窗口关闭）→ 自动清理 pid 文件再退出，
//      杜绝"窗口关了但 pid 文件残留"的孤儿文件。
//   3. 收到 SIGTERM/SIGINT（pnpm stop 杀组时）→ 转杀子进程、清 pid 文件、退出。
function runDaemon() {
  writeFileSync(pidFile, String(process.pid), 'utf8');
  const { cmd, args, shell } = commandFor();
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit', // supervisor 的 stdio 已是日志文件（或前台终端）
    shell,
    env: cleanEnv(),
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* 可能已退出 */
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    removePidFileIfOwn(process.pid);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  child.on('exit', (code) => {
    removePidFileIfOwn(process.pid);
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error('[dev-daemon] 启动失败:', err.message);
    removePidFileIfOwn(process.pid);
    process.exit(1);
  });
}

// ── status：查询运行状态 ─────────────────────────────────────────────
function statusDaemon() {
  const instances = findInstances(); // 已含 pid 文件中的有效条目
  const pidInFile = readPidFile();

  // pid 文件存在但没被 findInstances 认领 → 要么进程已死（陈旧），要么 pid 被复用
  if (pidInFile !== null && !instances.some(({ pid }) => pid === pidInFile)) {
    if (!isAlive(pidInFile)) {
      removePidFileIfOwn(pidInFile);
      if (!existsSync(pidFile)) {
        console.log(`[dev-daemon] pid 文件中的 pid=${pidInFile} 已退出（陈旧文件，已清理）。`);
      }
    } else {
      console.warn(`[dev-daemon] pid 文件中的 pid=${pidInFile} 存活但不属于本服务（可能已被复用），忽略。`);
    }
  }

  if (instances.length === 0) {
    console.log('[dev-daemon] 当前未运行。');
    return;
  }
  console.log(`[dev-daemon] 正在运行，共 ${instances.length} 个进程：`);
  for (const { pid, command } of instances) {
    console.log(`  - pid=${pid}  ${command.slice(0, 120)}`);
  }
  const listeners = portListeners(DEV_PORT);
  if (listeners.length > 0) {
    console.log(`[dev-daemon] 端口 ${DEV_PORT} 监听者: ${listeners.join(', ')}`);
  }
}

function startForeground() {
  preflight();
  const { cmd, args, shell } = commandFor();
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell,
    env: cleanEnv(),
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('[dev-daemon] 启动失败:', err.message);
    process.exit(1);
  });
}

// ── 入口 ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'start';
const daemon = process.argv.includes('--daemon');

if (mode === 'stop') {
  stopDaemon();
} else if (mode === 'status') {
  statusDaemon();
} else if (mode === 'run') {
  runDaemon(); // 内部模式：由 start --daemon 拉起，不建议手动执行
} else if (mode === 'start') {
  if (daemon) startDaemon();
  else startForeground();
} else {
  console.error('[dev-daemon] 用法: node scripts/dev-daemon.mjs [start|stop|status] [--daemon]');
  process.exit(1);
}
