#!/usr/bin/env node
// 发布产物校验 + SHA256SUMS 生成（发布链路 L3 完整性治理，见 docs/ci-release-pipeline.md）。
//
// 用法：
//   node scripts/verify-artifacts.mjs --platform mac [--version 0.2.0] [--dir dist/mac] [--out dist/mac/SHA256SUMS.mac]
//
// 行为：
//   1. 收集 --dir（默认 dist/）下 --platform 对应扩展名的产物文件；
//      产物按平台分目录（dist/mac dist/win dist/linux），调用方需显式传 --dir，见 docs/ci-release-pipeline.md §4；
//   2. --version 给定：校验每个产物文件名包含该版本号（防命名漂移，如 dmg 用了旧版本号）；
//   3. 校验每个产物非空；
//   4. 生成 SHA256SUMS 文件（"<hash>  <filename>"，两空格分隔，coreutils sha256sum 兼容）到 --out；
//   5. 打印校验报告；任一环节失败 exit 1（fail-closed，不产出不完整校验文件）。

import { readdirSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_DIR = 'dist';
// 平台 → 产物扩展名（与 electron-builder.yml / scripts/dist.mjs 产出保持一致）
const PLATFORM_EXT = {
  mac: ['.dmg'],
  win: ['.exe'],
  linux: ['.AppImage', '.deb'],
};

function fail(msg) {
  console.error(`[verify-artifacts] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { platform: null, version: null, dir: DEFAULT_DIR, out: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--platform') {
      opts.platform = argv[++i];
    } else if (a === '--version') {
      opts.version = argv[++i];
    } else if (a === '--dir') {
      opts.dir = argv[++i];
    } else if (a === '--out') {
      opts.out = argv[++i];
    } else {
      fail(`未知参数：${a}`);
    }
    i++;
  }
  return opts;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.platform == null) fail('必须指定 --platform（mac / win / linux）');
  const exts = PLATFORM_EXT[opts.platform];
  if (exts == null) fail(`不支持的平台：${opts.platform}（可选 mac / win / linux）`);

  let entries = [];
  try {
    entries = readdirSync(opts.dir, { withFileTypes: true });
  } catch {
    fail(`目录不存在或不可读：${opts.dir}`);
  }

  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => exts.some((ext) => name.endsWith(ext)))
    .sort();

  if (files.length === 0) {
    fail(`在 ${opts.dir}/ 下未找到平台 ${opts.platform} 的产物（扩展名 ${exts.join(' / ')}）`);
  }

  // 命名校验：文件名必须包含注入的版本号（release 模式强制，dry-run 可跳过）
  if (opts.version != null) {
    const bad = files.filter((name) => !name.includes(opts.version));
    if (bad.length > 0) {
      fail(`以下产物文件名不包含版本号 ${opts.version}（疑似命名漂移）：\n  ${bad.join('\n  ')}`);
    }
  }

  // 非空校验 + 生成 SHA256SUMS
  const lines = [];
  for (const name of files) {
    const abs = path.join(opts.dir, name);
    const stat = statSync(abs);
    if (stat.size === 0) fail(`产物为空文件：${name}`);
    const hash = await sha256(abs);
    lines.push(`${hash}  ${name}`);
    console.log(`[verify-artifacts] ok  ${name}  ${(stat.size / 1024 / 1024).toFixed(1)} MiB  sha256=${hash.slice(0, 16)}…`);
  }

  if (opts.out != null) {
    writeFileSync(opts.out, `${lines.join('\n')}\n`, 'utf8');
    console.log(`[verify-artifacts] SHA256SUMS 已写入 ${opts.out}（${files.length} 个产物）`);
  }
  console.log(`[verify-artifacts] 校验通过：${files.length} 个产物。`);
}

main().catch((e) => fail(e.message));
