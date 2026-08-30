#!/usr/bin/env node
// scripts/screenshots.mjs — 生成 README 界面截图（输出到 docs/images/）
//
// 用法:
//   node scripts/screenshots.mjs                      # 全自动：建演示工作区 → 启动 dev → CDP 截图 → 清理
//   node scripts/screenshots.mjs --ws /tmp/foo        # 自定义演示工作区（默认 /tmp/eif-shot-ws）
//   node scripts/screenshots.mjs --out docs/images    # 自定义输出目录（默认 docs/images）
//
// 产出（默认）:
//   docs/images/screenshot-main.png          主界面：文件树(git 角标 M/A/D/U) + Monaco 编辑器 + dirty 标记 + 状态栏
//   docs/images/screenshot-image-preview.png 图片预览（ImageViewer）
//   docs/images/screenshot-unsupported.png   二进制格式「暂不支持浏览」提示页
//   docs/images/screenshot-settings.png      设置面板（自动定时保存）
//
// 复用 scripts/e2e/ 的 CDP 基础设施与 EIF_AUTO_DIR 钩子机制（PIT 坑清单见 scripts/e2e/README.md）：
//   - 钩子：临时改写 FileSystemService.openDirectoryDialog，读取 EIF_AUTO_DIR 环境变量跳过
//     原生目录对话框；结束自动还原源码。
//   - 截图：Page.captureScreenshot 截取渲染进程 viewport（不含系统窗口装饰，README 展示最干净）。
// 工作区自包含：脚本内部用 Node 原生能力生成演示文件（含 PNG 渐变图 / 含 NUL 的假 PDF）
// 并初始化 git 仓库制造 M/A/D/U 四种状态，可重复运行。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { Cdp, sleep } from './e2e/cdp-client.mjs';
import * as H from './e2e/app-helpers.mjs';

// —— 常量 ——
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = argv('--ws') ?? '/tmp/eif-shot-ws';
const OUT = argv('--out') ?? path.join(ROOT, 'docs', 'images');
const CDP_PORT = 9333; // 避开 e2e 的 9222
const FS_FILE = path.join(ROOT, 'src/main/services/FileSystemService.ts');
const EV_BIN = path.join(ROOT, 'node_modules/.bin/electron-vite');

function argv(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ===== EIF_AUTO_DIR 临时钩子（注入/还原，与 scripts/e2e/run.mjs 同构）=====
const HOOK_MARK = '// [E2E-HOOK] EIF_AUTO_DIR';
const ORIG_ANCHOR = "async openDirectoryDialog(): Promise<string | null> {\n    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });";
const HOOKED = `async openDirectoryDialog(): Promise<string | null> {
    // [E2E-HOOK] EIF_AUTO_DIR: injected by scripts/screenshots.mjs (temporary, auto-restored)
    const auto = process.env.EIF_AUTO_DIR;
    if (auto) {
      const v = await this.validateRootCandidate(auto);
      if (!v.ok) return null;
      this.workspaceRoot = path.resolve(auto);
      return this.workspaceRoot;
    }
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });`;

let fsOriginal = null;

function injectHook() {
  let src = fs.readFileSync(FS_FILE, 'utf8');
  if (src.includes(HOOK_MARK)) {
    console.warn('[shots] 检测到 E2E-HOOK 残留，先还原再注入');
    src = src.replace(HOOKED, ORIG_ANCHOR);
  }
  if (!src.includes(ORIG_ANCHOR)) throw new Error('FileSystemService.ts 找不到 openDirectoryDialog 锚点');
  fsOriginal = src;
  fs.writeFileSync(FS_FILE, src.replace(ORIG_ANCHOR, HOOKED));
  console.log('[shots] EIF_AUTO_DIR 临时钩子已注入');
}

function restoreHook() {
  if (!fsOriginal) return;
  fs.writeFileSync(FS_FILE, fsOriginal);
  fsOriginal = null;
  console.log('[shots] FileSystemService.ts 已还原');
}

// ===== 演示工作区（自包含，幂等重建）=====
const WS_FILES = {
  'README.md': `# Demo Workspace

This workspace is used for FileEditor screenshots.

- Browse the file tree with git status badges
- Edit text/code files in Monaco
- Preview images inline
- Unsupported binary formats show a friendly notice

Current git status: this file has been modified since the last commit (M badge).
`,
  'src/main.ts': `// main.ts — demo TypeScript file with syntax highlighting
import { readFile } from 'node:fs/promises';

interface Task {
  id: number;
  title: string;
  done: boolean;
  tags?: string[];
}

const tasks: Task[] = [
  { id: 1, title: 'Browse workspace', done: true, tags: ['tree'] },
  { id: 2, title: 'Edit file with Monaco', done: true, tags: ['editor'] },
  { id: 3, title: 'Preview image', done: false, tags: ['viewer'] },
];

export async function loadTask(id: number): Promise<Task | undefined> {
  const data = await readFile('./tasks.json', 'utf-8');
  const all = JSON.parse(data) as Task[];
  return all.find((t) => t.id === id);
}

export function summarize(open: Task[]): string {
  const done = open.filter((t) => t.done).length;
  return \`\${done}/\${open.length} tasks completed\`;
}

// Run: node main.ts
console.log(summarize(tasks));
`,
  'src/newfile.ts': `// newfile.ts — staged (git add) but not yet committed (A badge)
export const staged = true;
`,
  'src/utils/helper.ts': `// helper.ts — untracked file (U badge)
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
  'deleted.txt': 'This file will be deleted from disk to demonstrate the D badge.\n',
};

// CRC-32（IEEE，PNG 要求），查表法
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writePng(file, w, h, pixelFn) {
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`  ✓ ${file} (${w}x${h})`);
}

function prepareWorkspace() {
  // 安全护栏：拒绝删除项目目录内路径（演示工作区只允许 /tmp 等外部路径）
  const resolvedWs = path.resolve(WS);
  if (resolvedWs.startsWith(path.resolve(ROOT))) {
    throw new Error(`--ws 不能指向项目内部目录（${resolvedWs}）`);
  }
  fs.rmSync(resolvedWs, { recursive: true, force: true });
  fs.mkdirSync(resolvedWs, { recursive: true });

  for (const [rel, content] of Object.entries(WS_FILES)) {
    const f = path.join(resolvedWs, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }

  // 渐变 PNG（蓝 → 紫 + 暖色圆环），演示图片预览
  const W = 800;
  const H = 500;
  const cx = W / 2;
  const cy = H / 2;
  const R = 120;
  const assetsDir = path.join(resolvedWs, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  writePng(path.join(assetsDir, 'logo.png'), W, H, (x, y) => {
    const t = (x + y) / (W + H);
    let r = Math.round(58 + 140 * t);
    let g = Math.round(92 + 46 * (1 - t));
    let b = Math.round(186 + 58 * t);
    const d = Math.hypot(x - cx, y - cy);
    if (d >= R - 26 && d <= R) {
      r = 255;
      g = Math.round(200 - (60 * (d - (R - 26))) / 26);
      b = 120;
    }
    return [r, g, b];
  });

  // 含 NUL 字节的假 PDF：probe 扫到 NUL → binary → UnsupportedViewer 演示
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n'),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  ]);
  fs.mkdirSync(path.join(resolvedWs, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(resolvedWs, 'docs', 'report.pdf'), pdf);

  // git 仓库 + 四种状态：M（README.md 已改）、A（newfile.ts 已 add）、D（deleted.txt 已删）、U（helper.ts 未跟踪）
  const run = (cmd) => execSync(cmd, { cwd: resolvedWs, stdio: 'ignore' });
  run('git init -q');
  run('git config user.email demo@example.com');
  run('git config user.name Demo');
  run('git add README.md deleted.txt src/main.ts assets/logo.png docs/report.pdf');
  run('git commit -qm initial');
  fs.appendFileSync(path.join(resolvedWs, 'README.md'), '# line appended after commit\n');
  run('git add src/newfile.ts');
  fs.rmSync(path.join(resolvedWs, 'deleted.txt'));
  console.log(`[shots] 演示工作区就绪: ${resolvedWs}`);
}

// ===== dev 生命周期 =====
const devLogs = [];
let devChild = null;

function startDev() {
  // [PIT-2] 剥离会破坏 dev 的环境残留
  const env = { ...process.env };
  delete env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
  delete env.CODEBUDDY_TOOL_CALL_ID;
  delete env.ELECTRON_RUN_AS_NODE;
  env.EIF_AUTO_DIR = path.resolve(WS);
  env.ELECTRON_DISABLE_SANDBOX = '1';

  devChild = spawn(EV_BIN, ['dev', '--', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devChild.stdout.on('data', (d) => devLogs.push(d.toString()));
  devChild.stderr.on('data', (d) => devLogs.push(d.toString()));
  devChild.on('exit', (code) => console.log(`[shots] dev 进程退出 code=${code}`));
}

function killDev() {
  for (const pat of ['electron-vite dev', `remote-debugging-port=${CDP_PORT}`]) {
    try {
      execSync(`pkill -f "${pat}"`, { stdio: 'ignore' });
    } catch {
      /* 无匹配进程，忽略 */
    }
  }
}

// 截图：失败抛错（避免 waitFor 超时后截到错误画面）
async function capture(cdp, name, waitExpr, waitName) {
  if (waitExpr) {
    const ok = await cdp.waitFor(waitName, waitExpr, 8000);
    if (!ok) throw new Error(`等待「${waitName}」超时，无法截取 ${name}`);
  }
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, name);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`  ✓ ${out} (${fs.statSync(out).size} bytes)`);
}

// 点击树中目录行（▸/▾ 前缀 + 名称尾匹配；目录行 textContent = '▸ src'）
const CLICK_DIR = (name) =>
  `(()=>{const el=[...document.querySelectorAll('[data-tree-row]')].find(d=>{const t=d.textContent.trim();return (t.startsWith('▸')||t.startsWith('▾'))&&t.endsWith('${name}');});if(!el)return false;el.click();return true;})()`;

// 文件行匹配：git 徽标 sup 追加在文件名后，textContent 形如 '📄 README.mdM'，用 includes(📄 + 名字) 而非 endsWith
const FILE_ROW = (name) => `[...document.querySelectorAll('div')].some(d=>(d.getAttribute('style')||'').includes('cursor')&&d.textContent.includes('📄 ${name}'))`;

// git 角标：等 M/A/U 三种 sup 徽标都渲染（D 不在树里——文件已删除，readDirectory 不会列出）
const GIT_BADGES_READY = `(()=>{const s=[...document.querySelectorAll('sup')].map(e=>e.textContent);return ['M','A','U'].every(c=>s.includes(c));})()`;

const UNSHOWN = `[...document.querySelectorAll('div')].some(d=>d.textContent==='暂不支持浏览')`;
const SETTINGS_SHOWN = `[...document.querySelectorAll('label')].some(l=>l.textContent.includes('启用自动定时保存'))`;
const IMG_SHOWN = `[...document.querySelectorAll('img')].some(i=>(i.src||'').startsWith('data:image'))`;

async function rendererReady(cdp) {
  // Electron 窗口刚创建时 CDP target 可能是 about:blank（localStorage 访问被拒 SecurityError），
  // 先等 vite dev server 页面真正加载
  if (!(await cdp.waitFor('渲染页面加载', `location.href.startsWith('http://localhost')`, 30000)))
    throw new Error('渲染页面未加载（vite dev server）');
  // [PIT-16] localStorage 残留（自动保存开关）会污染状态：清空 + reload
  await cdp.ev(`localStorage.clear(); true`);
  await cdp.ev(`location.reload(); true`);
  await sleep(1500);
  return H.waitToolbar(cdp);
}

async function shotMain(cdp) {
  console.log('\n── 截图 1/4: 主界面（文件树 + Monaco + git 角标 + dirty）──');
  await H.openFolder(cdp); // EIF_AUTO_DIR 钩子直接打开 WS
  if (!(await cdp.waitFor('树加载 README.md', FILE_ROW('README.md'), 10000)))
    throw new Error('树未加载（README.md）');
  // 展开所有目录，确保 logo.png / report.pdf / helper.ts 都可见
  for (const dir of ['src', 'utils', 'assets', 'docs']) {
    await cdp.ev(CLICK_DIR(dir));
  }
  if (!(await cdp.waitFor('展开后 helper.ts 出现', FILE_ROW('helper.ts'), 8000)))
    throw new Error('helper.ts 未出现（utils 展开失败）');
  if (!(await cdp.waitFor('展开后 logo.png 出现', FILE_ROW('logo.png'), 8000)))
    throw new Error('logo.png 未出现（assets 展开失败）');
  if (!(await cdp.waitFor('git 角标 M/A/U 渲染', GIT_BADGES_READY, 8000)))
    throw new Error('git 角标 M/A/U 未就绪');

  await H.openTreeFile(cdp, 'main.ts');
  await H.waitEditor(cdp);
  // 触发 dirty：点最后一行末尾追加空格（视觉无感，tab 出现 • 标记）
  const lastPt = await cdp.ev(
    `(()=>{const ls=document.querySelectorAll('.view-line');const r=ls[ls.length-1].getBoundingClientRect();return {x:r.x+Math.min(10,r.width/2),y:r.y+r.height/2};})()`,
  );
  await cdp.mouseClick(lastPt.x, lastPt.y);
  await cdp.pressKey('End', 'End', 35);
  await cdp.insertText(' ');
  if (
    !(await cdp.waitFor(
      'dirty 标记',
      `[...document.querySelectorAll('span')].some(s=>s.textContent.includes('main.ts')&&/[•●◦]/.test(s.textContent)&&s.textContent.length<40)`,
      4000,
    ))
  )
    throw new Error('dirty 标记未出现');
  await sleep(500); // git 徽标/布局稳定
  await capture(cdp, 'screenshot-main.png');
}

async function shotImagePreview(cdp) {
  console.log('\n── 截图 2/4: 图片预览 ──');
  await H.openTreeFile(cdp, 'logo.png');
  await capture(cdp, 'screenshot-image-preview.png', IMG_SHOWN, 'ImageViewer 图片加载');
}

async function shotUnsupported(cdp) {
  console.log('\n── 截图 3/4: 不支持格式提示 ──');
  await H.openTreeFile(cdp, 'report.pdf');
  await capture(cdp, 'screenshot-unsupported.png', UNSHOWN, '暂不支持浏览提示页');
}

async function shotSettings(cdp) {
  console.log('\n── 截图 4/4: 设置面板 ──');
  await H.openSettings(cdp);
  await capture(cdp, 'screenshot-settings.png', SETTINGS_SHOWN, '设置面板出现');
  await cdp.ev(`${H.BTN('取消')}.click()`); // 关闭设置，保持界面干净
  await sleep(300);
}

// ===== 主编排 =====
async function main() {
  console.log(`=== file-editor screenshots (CDP :${CDP_PORT}) ===`);
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) throw new Error(`需要 Node >= 22（当前 ${process.version}）`);

  injectHook();
  prepareWorkspace();
  killDev();
  await sleep(800);
  startDev();

  try {
    const cdp = await Cdp.connect(CDP_PORT, 90000);
    try {
      if (!(await rendererReady(cdp))) throw new Error('工具栏未就绪');
      await shotMain(cdp);
      await shotImagePreview(cdp);
      await shotUnsupported(cdp);
      await shotSettings(cdp);
    } finally {
      cdp.close();
    }
  } catch (e) {
    console.error('\n[shots] 运行异常:', e.message);
    if (devLogs.length) console.error('\n--- dev 日志（末 50 行）---\n' + devLogs.join('').slice(-8000));
  }
}

// —— 兜底清理（同步，异常中断也执行）——
process.on('exit', () => {
  try {
    restoreHook();
  } catch {
    /* noop */
  }
  try {
    killDev();
  } catch {
    /* noop */
  }
});

try {
  await main();
} catch (e) {
  console.error('\n[shots] 致命错误:', e.message);
} finally {
  try {
    restoreHook();
  } catch {
    /* noop */
  }
  try {
    killDev();
  } catch {
    /* noop */
  }
  console.log('[shots] 收尾完成：钩子已还原、dev 已停止');
}
