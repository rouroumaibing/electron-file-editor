#!/usr/bin/env node
// run.mjs — file-editor CDP e2e 主编排
//
// 用法:
//   npm run e2e                # 全自动：注入钩子 → 启动 dev → 跑场景 → 还原清理
//   npm run e2e -- --keep-ws   # 结束后保留 /tmp/eif-e2e-ws 工作区（便于人工复现）
//
// 覆盖场景（合并历史 v3/v4 CDP 验证）:
//   S1 手动保存「保存成功」反馈（工具栏）
//   S2 外部修改提示条 + 「重新加载外部版本」二次确认（取消保留 / 确定加载）
//   S3 「保留当前版本」不清 dirty，随后保存 force 覆盖外部修改
//   S4 自动保存定时器路径：「自动保存成功」反馈 + 落盘 + dirty 清除 + 无 dirty 不提示
//   S5 回归：clean 文件外部修改 → 自动重载（无提示条 / 无 modal）
//
// 生命周期安全：FileSystemService.ts 钩子注入/还原、dev 启动/停止、临时工作区
// 清理均在 finally + process.on('exit') 双重兜底，异常中断也不会留残留。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, sleep } from './cdp-client.mjs';
import { Assertion } from './util.mjs';
import * as H from './app-helpers.mjs';

// —— 常量 ——
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WS = '/tmp/eif-e2e-ws';
const CDP_PORT = 9222;
const FS_FILE = path.join(ROOT, 'src/main/services/FileSystemService.ts');
const EV_BIN = path.join(ROOT, 'node_modules/.bin/electron-vite');
const KEEP_WS = process.argv.includes('--keep-ws');

// —— EIF_AUTO_DIR 临时钩子（注入/还原，保存原文最可靠）——
const HOOK_MARK = '// [E2E-HOOK] EIF_AUTO_DIR';
const ORIG_ANCHOR = "async openDirectoryDialog(): Promise<string | null> {\n    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });";
const HOOKED = `async openDirectoryDialog(): Promise<string | null> {
    // [E2E-HOOK] EIF_AUTO_DIR: injected by scripts/e2e/run.mjs (temporary, auto-restored)
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
    // 上次运行中断残留：先按固定结构还原（幂等）
    console.warn('[e2e] 检测到 E2E-HOOK 残留，先还原再注入');
    src = src.replace(HOOKED, ORIG_ANCHOR);
  }
  if (!src.includes(ORIG_ANCHOR)) throw new Error('FileSystemService.ts 找不到 openDirectoryDialog 锚点');
  fsOriginal = src;
  fs.writeFileSync(FS_FILE, src.replace(ORIG_ANCHOR, HOOKED));
  console.log('[e2e] EIF_AUTO_DIR 临时钩子已注入');
}

function restoreHook() {
  if (!fsOriginal) return;
  fs.writeFileSync(FS_FILE, fsOriginal);
  fsOriginal = null;
  console.log('[e2e] FileSystemService.ts 已还原');
}

// —— dev 生命周期 ——
const devLogs = [];
let devChild = null;

function startDev() {
  // [PIT-2] 剥离会破坏 dev 的环境残留：ELECTRON_RUN_AS_NODE / CODEBUDDY_SAFE_DELETE_*
  const env = { ...process.env };
  delete env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
  delete env.CODEBUDDY_TOOL_CALL_ID;
  delete env.ELECTRON_RUN_AS_NODE;
  env.EIF_AUTO_DIR = WS;
  env.ELECTRON_DISABLE_SANDBOX = '1';

  devChild = spawn(EV_BIN, ['dev', '--', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  devChild.stdout.on('data', (d) => devLogs.push(d.toString()));
  devChild.stderr.on('data', (d) => devLogs.push(d.toString()));
  devChild.on('exit', (code) => console.log(`[e2e] dev 进程退出 code=${code}`));
}

function killDev() {
  // electron-vite dev 会再拉起 electron 子进程，按命令行模式匹配 pkill
  for (const pat of ['electron-vite dev', `remote-debugging-port=${CDP_PORT}`]) {
    try { execSync(`pkill -f "${pat}"`, { stdio: 'ignore' }); } catch { /* 无匹配进程，忽略 */ }
  }
}

// —— 测试工作区 ——
function resetWsFile(name, content) {
  fs.writeFileSync(path.join(WS, name), content);
}

function wsContent(name) {
  return fs.readFileSync(path.join(WS, name), 'utf8');
}

function waitForFeedback(cdp, text, timeoutMs = 6000) {
  return cdp.waitFor(`反馈「${text}」`, `[...document.querySelectorAll('span')].some(s=>s.textContent==='${text}')`, timeoutMs);
}

// —— 渲染层状态重置 ——
// [PIT-16] localStorage 持久化 autoSaveEnabled/interval（设置面板仅渲染层存储）：
// 上次测试或手工操作残留的「自动保存开启」会让定时器抢先保存、清掉 dirty，
// 导致外部修改判定从「提示条」降级为「自动重载」——必须开局清空并 reload。
async function resetRendererState(cdp) {
  await cdp.ev(`localStorage.clear(); true`);
  await cdp.ev(`location.reload(); true`);
  await sleep(1500); // reload 后 React 重挂载
}

// —— 场景 ——
async function s1_manual_save(cdp, a) {
  console.log('\n── S1 手动保存「保存成功」反馈 ──');
  resetWsFile('hello.txt', 'v1-hello\n');
  await H.openFolder(cdp);
  a.check('打开文件 hello.txt', await H.openTreeFile(cdp, 'hello.txt'));
  await H.waitEditor(cdp);
  a.check('初始内容 v1-hello', (await H.editorText(cdp)).includes('v1-hello'));

  await H.typeAtEnd(cdp, 'EDITED'); // [PIT-7] 无前导空格，避开 NBSP 坑
  a.check('编辑生效（内容含 EDITED）', (await H.editorText(cdp)).includes('EDITED'));
  a.check('dirty 标记出现', await H.isDirty(cdp, 'hello.txt'));

  await cdp.ev(`${H.BTN('保存')}.click()`);
  a.check('底部反馈「保存成功」', await waitForFeedback(cdp, '保存成功'));
  a.check('磁盘已写入（含 EDITED）', wsContent('hello.txt').includes('EDITED'));
  a.check('保存后 dirty 清除', !(await H.isDirty(cdp, 'hello.txt')));
}

async function s2_reload_confirm(cdp, a) {
  console.log('\n── S2 外部修改提示条 + 重新加载二次确认 ──');
  await H.typeAtEnd(cdp, 'X2');
  a.check('编辑制造 dirty', await H.isDirty(cdp, 'hello.txt'));

  // [PIT-18] SELF_WRITE_TTL=1000ms（FileSystemService §5.5）：S1 保存已 markSelf(hello.txt)，
  // 1s 内的外部写会被 isSelf() 误判为 self（无提示条）——等 TTL 过期再外部写
  await sleep(1500);
  resetWsFile('hello.txt', 'v2-external\n'); // 外部修改（fs 直接写盘，触发 watcher）
  a.check('提示条出现', await cdp.waitFor('外部修改提示条', `[...document.querySelectorAll('div')].some(d=>d.textContent.includes('在外部被修改')&&d.textContent.length<200)`, 5000));
  a.check('提示条双按钮齐全', (await H.noteBtnCount(cdp)) === 2);

  // —— 取消路径：点「重新加载外部版本」→ modal → 取消 → 全部状态保留 ——
  await cdp.ev(`${H.BTN('重新加载外部版本')}.click()`);
  a.check('二次确认 modal 出现', await cdp.waitFor('确认 modal', `!!(${H.BTN('确定重新加载')})`, 3000));
  const modalMsg = await cdp.ev(`(()=>{const e=[...document.querySelectorAll('div')].find(d=>d.textContent.includes('将丢弃')&&d.textContent.includes('未保存改动'));return e?e.textContent:null;})()`);
  a.check('modal 文案含文件名', !!modalMsg?.includes('hello.txt'));
  a.check('modal 取消按钮存在', await H.modalCancelShown(cdp));

  await cdp.ev(`${H.BTN('取消')}.click()`);
  a.check('取消后 modal 关闭', !(await H.modalShown(cdp)));
  a.check('取消后内容未变（保留未保存编辑）', (await H.editorText(cdp)).includes('X2'));
  a.check('取消后 dirty 保留', await H.isDirty(cdp, 'hello.txt'));
  a.check('取消后提示条仍在', await H.noteShown(cdp));

  // —— 确定路径：再点 → 确定 → 加载外部版本、dirty/提示条清除 ——
  await cdp.ev(`${H.BTN('重新加载外部版本')}.click()`);
  await cdp.waitFor('二次确认 modal 再次出现', `!!(${H.BTN('确定重新加载')})`, 3000);
  await cdp.ev(`${H.BTN('确定重新加载')}.click()`);
  a.check('确定后 modal 关闭', !(await H.modalShown(cdp)));
  // reloadFile 异步（读盘 + Monaco setModel 有延迟）：modal 同步关，但内容/Dirty 要轮询等
  a.check('内容变为外部版本', await cdp.waitFor('内容=外部版本', `${H.EDITOR_TEXT}.includes('v2-external')`, 5000));
  a.check('dirty 已清除', !(await H.isDirty(cdp, 'hello.txt')));
  a.check('提示条消失', !(await H.noteShown(cdp)));
}

async function s3_keep_and_force_save(cdp, a) {
  console.log('\n── S3 保留当前版本 + 保存 force 覆盖 ──');
  await H.typeAtEnd(cdp, 'KEEP');
  a.check('编辑制造 dirty', await H.isDirty(cdp, 'hello.txt'));

  await sleep(1500); // [PIT-18] 同上：S1 保存的 markSelf 早已过期，此处统一等 TTL 保险
  resetWsFile('hello.txt', 'v3-external\n');
  a.check('提示条出现', await cdp.waitFor('外部修改提示条', `[...document.querySelectorAll('div')].some(d=>d.textContent.includes('在外部被修改')&&d.textContent.length<200)`, 5000));

  await cdp.ev(`${H.BTN('保留当前版本')}.click()`);
  a.check('保留后提示条消失', !(await H.noteShown(cdp)));
  a.check('保留后 dirty 不清（继续我的编辑）', await H.isDirty(cdp, 'hello.txt'));
  a.check('保留后内容仍是未保存编辑', (await H.editorText(cdp)).includes('KEEP'));

  await cdp.ev(`${H.BTN('保存')}.click()`);
  a.check('保存成功反馈', await waitForFeedback(cdp, '保存成功'));
  a.check('磁盘 = 我的编辑（force 覆盖外部，无拒绝）', wsContent('hello.txt').includes('KEEP') && !wsContent('hello.txt').includes('v3-external'));
}

async function s4_autosave(cdp, a) {
  console.log('\n── S4 自动保存定时器路径 ──');
  // 设置：开启自动保存 + 间隔 2s（[PIT-9][PIT-10]；间隔过短会吞 dirty 观测窗口）
  await H.openSettings(cdp);
  a.check('设置面板 checkbox 置为开启', await H.ensureAutoSaveChecked(cdp, true));
  a.check('间隔输入设为 2', await H.setAutoSaveInterval(cdp, 2));
  a.check('间隔值确认', (await cdp.ev(`document.querySelector('input[type="number"]').value`)) === '2');
  await H.closeSettings(cdp);

  await H.typeAtEnd(cdp, 'AUTO');
  a.check('编辑产生 dirty', await H.isDirty(cdp, 'hello.txt'));

  a.check('底部反馈「自动保存成功」', await waitForFeedback(cdp, '自动保存成功', 6000));
  a.check('磁盘已自动落盘（含 AUTO）', wsContent('hello.txt').includes('AUTO'));
  a.check('自动保存后 dirty 清除', !(await H.isDirty(cdp, 'hello.txt')));
  a.check('反馈 2.5s 后消失', await cdp.waitFor('反馈消失', `[...document.querySelectorAll('span')].every(s=>s.textContent!=='自动保存成功')`, 6000));

  // 无 dirty 时定时器触发不提示（saved>0 才提示的条件成立）
  await sleep(4500); // > 2s 间隔，足够下一轮定时器触发
  a.check('无 dirty 时无「自动保存成功」残留', !(await H.feedbackText(cdp)));

  // 关自动保存（顺带验证关闭路径），手动保存显示「保存成功」且与自动文案互不污染
  await H.openSettings(cdp);
  await H.ensureAutoSaveChecked(cdp, false);
  await H.closeSettings(cdp);
  await H.typeAtEnd(cdp, 'MANUAL');
  await cdp.ev(`${H.BTN('保存')}.click()`);
  a.check('手动保存显示「保存成功」', await waitForFeedback(cdp, '保存成功'));
  a.check('磁盘含 MANUAL', wsContent('hello.txt').includes('MANUAL'));
}

async function s5_clean_auto_reload(cdp, a) {
  console.log('\n── S5 回归：clean 文件外部修改 → 自动重载 ──');
  resetWsFile('readme.md', 'v1-readme\n'); // 新文件，model 无残留
  a.check('打开文件 readme.md', await H.openTreeFile(cdp, 'readme.md'));
  await H.waitEditor(cdp);
  a.check('初始内容 v1-readme', (await H.editorText(cdp)).includes('v1-readme'));

  resetWsFile('readme.md', 'v2-readme\n'); // clean 文件外部修改
  await sleep(1600); // watcher + 自动重载（§8.2：已保存文件外部改动直接重载）
  a.check('内容自动重载为外部版本', (await H.editorText(cdp)).includes('v2-readme'));
  a.check('无提示条（clean 不打扰）', !(await H.noteShown(cdp)));
  a.check('无二次确认 modal', !(await H.modalShown(cdp)));
}

// —— 主编排 ——
async function main() {
  console.log(`=== file-editor e2e (CDP :${CDP_PORT}) ===`);

  // 0. 环境检查：Node >= 22（原生 WebSocket / fetch）
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) throw new Error(`需要 Node >= 22（当前 ${process.version}），原生 WebSocket 不可用`);

  const a = new Assertion();

  // 1. 注入钩子
  injectHook();

  // 2. 工作区准备
  fs.mkdirSync(WS, { recursive: true });

  // 3. 启动 dev（先清理旧实例）
  killDev();
  await sleep(800);
  startDev();

  try {
    // 4. 连接 CDP（含冷启动等待），重置渲染层 localStorage 残留（PIT-16）
    const cdp = await Cdp.connect(CDP_PORT, 90000);
    try {
      await resetRendererState(cdp);
      if (!(await H.waitToolbar(cdp))) throw new Error('工具栏未就绪');

      await s1_manual_save(cdp, a);
      await s2_reload_confirm(cdp, a);
      await s3_keep_and_force_save(cdp, a);
      await s4_autosave(cdp, a);
      await s5_clean_auto_reload(cdp, a);
    } finally {
      cdp.close();
    }
  } catch (e) {
    console.error('\n[e2e] 运行异常:', e.message);
    if (devLogs.length) console.error('\n--- dev 日志（末 50 行）---\n' + devLogs.join('').slice(-8000));
  }

  const ok = a.summary();
  return ok;
}

// —— 兜底清理（同步，异常中断也执行）——
process.on('exit', () => {
  try { restoreHook(); } catch { /* noop */ }
  try { killDev(); } catch { /* noop */ }
});

let exitCode = 1;
try {
  exitCode = (await main()) ? 0 : 1;
} catch (e) {
  console.error('\n[e2e] 致命错误:', e.message);
} finally {
  try { restoreHook(); } catch { /* noop */ }
  try { killDev(); } catch { /* noop */ }
  if (!KEEP_WS) {
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* noop */ }
  }
  console.log(`\n[e2e] 收尾完成：钩子${fsOriginal ? '未' : '已'}还原、dev 已停止、临时工作区${KEEP_WS ? '保留' : '已清理'}`);
}
process.exit(exitCode);
