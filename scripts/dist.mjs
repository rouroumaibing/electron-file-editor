#!/usr/bin/env node
// 统一分发构建包装器：把 electron-builder 的「平台 / 架构 / 邮箱」三个维度参数化。
//
// 用法（pnpm 脚本已封装，见 package.json）：
//   pnpm dist                # 当前平台，全部架构（x64 + arm64）
//   pnpm dist:mac            # macOS dmg（x64 + arm64 双架构）
//   pnpm dist:mac:x64        # 仅 Intel
//   pnpm dist:mac:arm64      # 仅 Apple Silicon
//   pnpm dist:win[:x64|:arm64]
//   pnpm dist:linux[:x64|:arm64]
//   pnpm dist:all            # mac + win + linux 全平台全架构
//   pnpm dist -- --dir       # `--` 后参数原样透传 electron-builder（如 --dir 快速出未打包目录）
//
// 邮箱（用于 deb maintainer / 包作者）：
//   pnpm dist --email you@example.com     # 命令行指定
//   DIST_EMAIL=you@example.com pnpm dist  # 或环境变量指定
//   都不给时用默认值 rouroumaibing@qq.com（electron-builder.yml 内同值兜底）。
//
// 版本号（发布链路唯一参数，见 docs/ci-release-pipeline.md「版本链」）：
//   pnpm dist --version 0.2.0             # 注入 -c.extraMetadata.version，不改写 package.json
//   不传时沿用 package.json 的 version 字段。
//
// 产物目录（按平台分离，dist/<platform>/，见设计文档 §12.2）：
//   - mac   -> dist/mac/   （*.dmg）
//   - win   -> dist/win/   （*.exe）
//   - linux -> dist/linux/ （*.AppImage / *.deb）
//   electron-builder 的 directories.output 是全局配置，多平台同批构建无法分目录，
//   故 dist.mjs 对每个平台独立执行一次 builder，并注入 -c.directories.output=dist/<platform>。
//   out/（electron-vite 中间产物）与 dist/（安装包）分离，pnpm clean 分别清理。
//
// macOS 签名降级（无凭据自动 ad-hoc）：
//   未设置 CSC_LINK / CSC_KEY_PASSWORD 时，mac 产物自动附加
//   -c.mac.identity=- -c.mac.hardenedRuntime=false（ad-hoc 签名）。
//   效果：Gatekeeper 从「已损坏」降级为「未识别开发者 → 右键打开」。
//   有证书（CI 注入或本地显式设置）时不做此覆盖，走正式签名。
//
// 调试：
//   pnpm dist:mac --dry-run              # 只打印解析结果与最终 builder 参数，不执行构建
//   （注意 --dry-run 必须不带 `--`；`--` 之后是 electron-builder 透传区，--dry-run 放后面不会生效）
//
// 跨平台限制（electron-builder 的硬约束，非本脚本限制）：
//   - macOS dmg/签名 只能在 macOS 主机上构建 —— 非 macOS 主机上 dist:mac / dist:all 会直接报错或跳过 mac；
//   - win/linux 可从任意主机交叉构建（NSIS 交叉打包首次可能需要 wine），可靠路径仍是 CI 三端矩阵。

import { spawnSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EMAIL = 'rouroumaibing@qq.com';
const OS_OF = { mac: 'darwin', win: 'win32', linux: 'linux' };
const ALL_ARCHES = ['x64', 'arm64'];

function fail(msg) {
  console.error(`[dist] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { platforms: null, arches: [...ALL_ARCHES], email: null, version: null, dryRun: false, passthrough: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--platform') {
      opts.platforms = argv[++i];
    } else if (a === '--arch') {
      const v = argv[++i];
      opts.arches = v === 'all' ? [...ALL_ARCHES] : v.split(',').map((s) => s.trim());
    } else if (a === '--email') {
      opts.email = argv[++i];
    } else if (a === '--version') {
      opts.version = argv[++i];
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--') {
      opts.passthrough = argv.slice(i + 1);
      break;
    } else {
      opts.passthrough.push(a); // 容错：未知的直接透传给 electron-builder
    }
    i++;
  }
  return opts;
}

function resolvePlatforms(spec) {
  const host = osPlatform();
  if (!spec) {
    return Object.entries(OS_OF)
      .filter(([, os]) => os === host)
      .map(([name]) => name);
  }
  if (spec === 'all') return ['mac', 'win', 'linux'];
  return spec.split(',').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const email = opts.email || process.env.DIST_EMAIL || DEFAULT_EMAIL;

  // 归一化邮箱 → deb maintainer 格式（"Name <email>"；已带 <> 的原样使用）
  const maintainer = email.includes('<') ? email.trim() : `sounds-great-ai <${email.trim()}>`;

  let platforms = resolvePlatforms(opts.platforms);
  if (platforms.length === 0) fail(`无法识别平台：${opts.platforms || osPlatform()}`);
  for (const a of opts.arches) {
    if (!ALL_ARCHES.includes(a)) fail(`不支持的架构：${a}（可选 x64 / arm64 / all）`);
  }
  if (opts.version != null && !/^\d+\.\d+\.\d+/.test(opts.version)) {
    fail(`非法版本号：${opts.version}（需满足 semver 形如 0.2.0）`);
  }

  // macOS 产物只能在 macOS 上构建：显式指定则报错，dist:all 里则跳过并提示
  const host = osPlatform();
  const macOnNonMac = platforms.includes('mac') && host !== 'darwin';
  if (macOnNonMac) {
    if (opts.platforms === 'mac') {
      fail('macOS 产物只能在 macOS 主机上构建（签名/dmg 工具链限制）。请在 Mac 上运行 pnpm dist:mac，或使用 CI 矩阵。');
    }
    platforms = platforms.filter((p) => p !== 'mac');
    console.warn('[dist] 非 macOS 主机：已跳过 mac 目标（mac 产物请走 macOS 主机或 CI）。');
  }
  if (platforms.length === 0) fail('没有可构建的平台。');
  if (platforms.includes('win') && host !== 'win32') {
    console.warn('[dist] 交叉构建 Windows：首次会下载 NSIS/makensis，部分场景可能需要 wine；可靠路径是 CI 的 windows-latest 矩阵。');
  }

  const archFlags = opts.arches.flatMap((a) => [`--${a}`]);
  const platformFlag = (p) => ({ mac: '-m', win: '-w', linux: '-l' })[p];

  // macOS 无签名凭据 → 降级 ad-hoc 签名：-c.mac.identity=- 关闭正式签名，
  // 同时必须关 hardenedRuntime（ad-hoc 与 hardened runtime 不兼容，未公证的 HR app 无法右键打开）。
  const hasSigningCred = Boolean(process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD);

  // 每个平台独立一次 electron-builder 调用，产物按平台分目录 dist/<platform>/
  // （directories.output 是全局配置，多平台同批构建会混进同一目录，故循环拆开）
  const runs = platforms.map((p) => {
    const args = [
      platformFlag(p),
      ...archFlags,
      `-c.linux.maintainer=${maintainer}`,
      `-c.directories.output=dist/${p}`,
      ...opts.passthrough,
    ];
    // 版本注入：-c.extraMetadata.version 覆盖 package.json.version（不改写源文件，规避文本改写脆弱性）
    if (opts.version != null) {
      args.push(`-c.extraMetadata.version=${opts.version}`);
    }
    if (p === 'mac' && host === 'darwin' && !hasSigningCred) {
      args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
    }
    return { platform: p, args };
  });

  console.log(`[dist] 平台=${platforms.join('+')} 架构=${opts.arches.join('+')} maintainer=${maintainer}`);
  if (opts.version != null) console.log(`[dist] 注入版本=${opts.version}（extraMetadata.version）`);
  if (opts.passthrough.length) console.log(`[dist] 透传参数: ${opts.passthrough.join(' ')}`);
  for (const r of runs) console.log(`[dist] ${r.platform} 产物目录: dist/${r.platform}/`);
  if (platforms.includes('mac') && host === 'darwin' && !hasSigningCred) {
    console.log('[dist] 未检测到签名证书：mac 产物采用 ad-hoc 签名（首次运行需右键 → 打开）。');
  }

  if (opts.dryRun) {
    console.log('[dist] DRY-RUN 不执行构建。最终 builder 参数:');
    for (const r of runs) console.log(`[dist]   ${r.platform}: ${r.args.join(' ')}`);
    return;
  }

  // 1) 渲染/主/preload 三进程构建（每次分发都先全量 build，保证产物新鲜）
  const viteBin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  const r1 = spawnSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });
  if (r1.status !== 0) fail('electron-vite build 失败。');

  // 2) 按平台循环 electron-builder 打包
  const builderBin = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  for (const r of runs) {
    const r2 = spawnSync(process.execPath, [builderBin, ...r.args], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false' },
    });
    if (r2.status !== 0) fail(`electron-builder 打包失败（${r.platform}）。`);
    console.log(`[dist] ${r.platform} 完成。产物见 dist/${r.platform}/ 目录。`);
  }
  console.log('[dist] 全部完成。');
}

main();
