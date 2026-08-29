// app-helpers.mjs — 应用层 UI 操作（全部经 CDP 页面内表达式或合成输入）
//
// 已知坑注释（完整清单见 scripts/e2e/README.md）：
//   [PIT-4] 树行节点 textContent 是 `📄 {name}`（emoji 前缀）——匹配 `📄 ` 前缀 + endsWith(name)；
//           可点击行是含 cursor 样式属性的 div（onClick 在行 div 上，li 容器点击无效）
//   [PIT-5] Monaco 0.56 输入区类名是 .ime-text-area（非旧版 .inputarea）；
//           直接 focus() 会破坏输入状态导致 insertText 被吞——必须 dispatchMouseEvent
//           真实点击内容区后再输入（见 typeAtEnd）
//   [PIT-6] Monaco 刚挂载有 ~1.2s 初始化窗口，立即输入被吞——waitEditor 内含稳定 sleep
//   [PIT-7] CDP insertText 的前导空格会被 Monaco 规范化为 NBSP(U+00A0)——断言用
//           includes('TEXT') 而非 includes(' TEXT')；本套件编辑文本一律不带前导空格
//   [PIT-8] dirty 标记是 tab 内 span 文本 ' •' 变体（非独立元素）：匹配 span + /[•●◦]/ + 长度限制
//   [PIT-9] SettingsModal 数字输入是 React 受控组件：需原生 setter + input 事件才触发 onChange
//   [PIT-10] checkbox 初始态可能因 localStorage 残留已勾选：先读 checked 再决定是否点击
import { sleep } from './util.mjs';

// —— 基础按钮/元素表达式（页面内求值）——
export const BTN = (t) => `[...document.querySelectorAll('button')].find(b=>b.textContent==='${t}')`;
export const BTN_BY_LABEL = (t) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${t}')`;

// —— 等待/打开 ——
export async function waitToolbar(cdp) {
  // [PIT-11] dev 新启动时 React 尚未挂载，按钮不存在——先等工具栏就绪再点击
  return cdp.waitFor('工具栏就绪', `!!(${BTN('打开文件夹')})`, 30000);
}

export async function openFolder(cdp) {
  await cdp.ev(`${BTN('打开文件夹')}.click()`);
  await sleep(400);
}

export async function openTreeFile(cdp, name) {
  // [PIT-4] 行 div：style 含 cursor 且文本为 `📄 {name}`；先等树行出现（懒加载）再点击
  const rowExpr = `[...document.querySelectorAll('div')].some(d=>(d.getAttribute('style')||'').includes('cursor')&&d.textContent.trim().startsWith('📄')&&d.textContent.trim().endsWith('${name}'))`;
  const ok = await cdp.waitFor(`树行 ${name} 出现`, rowExpr, 8000);
  if (!ok) return false;
  // 注意：click() 返回 undefined，不能用 `?.click() !== undefined` 判断（恒 false）
  const clicked = await cdp.ev(
    `(()=>{const el=[...document.querySelectorAll('div')].find(d=>(d.getAttribute('style')||'').includes('cursor')&&d.textContent.trim().startsWith('📄')&&d.textContent.trim().endsWith('${name}'));if(!el)return false;el.click();return true;})()`
  );
  await sleep(400);
  return clicked;
}

// —— Monaco 编辑器 ——
export async function waitEditor(cdp) {
  const ok = await cdp.waitFor('Monaco 加载', `!!document.querySelector('.monaco-editor') && document.querySelectorAll('.view-line').length>0`, 10000);
  await sleep(1200); // [PIT-6] Monaco 初始化窗口：立即输入被吞
  return ok;
}

export const EDITOR_TEXT = `[...document.querySelectorAll('.view-line')].map(l=>l.textContent).join('\\n')`;

export async function editorText(cdp) {
  return cdp.ev(EDITOR_TEXT);
}

export async function clickEditor(cdp) {
  // [PIT-5] 真实点击内容区获取焦点（focus() 会破坏 Monaco 输入态）
  const pt = await cdp.ev(
    `(()=>{const r=document.querySelector('.view-line').getBoundingClientRect();return {x:r.x+Math.min(40,r.width/2),y:r.y+r.height/2};})()`
  );
  await cdp.mouseClick(pt.x, pt.y);
  await sleep(300);
}

export async function typeAtEnd(cdp, text) {
  await clickEditor(cdp);
  await cdp.pressKey('End', 'End', 35); // 定位行尾
  await cdp.insertText(text); // [PIT-7] text 不要带前导空格
  await sleep(350); // model 更新 + dirty state 传播
}

// —— 状态检查 ——
export function isDirty(cdp, name) {
  // [PIT-8] dirty 标记：tab 是 span（非 div），字符变体 [•●◦]，限定长度排除整棵子树
  return cdp.ev(
    `[...document.querySelectorAll('span')].some(s=>s.textContent.includes('${name}')&&/[•●◦]/.test(s.textContent)&&s.textContent.length<40)`
  );
}

export function feedbackText(cdp) {
  // 底部保存反馈（statusBarFeedback span，文本精确为 保存成功 / 自动保存成功）
  return cdp.ev(`(()=>{const e=[...document.querySelectorAll('span')].find(s=>s.textContent==='保存成功'||s.textContent==='自动保存成功');return e?e.textContent:null;})()`);
}

export function noteShown(cdp) {
  // 外部修改提示条：文本含「在外部被修改」的容器
  return cdp.ev(
    `[...document.querySelectorAll('div')].some(d=>d.textContent.includes('在外部被修改')&&d.textContent.length<200)`
  );
}

export async function noteBtnCount(cdp) {
  return cdp.ev(
    `[${BTN('重新加载外部版本')},${BTN('保留当前版本')}].filter(Boolean).length`
  );
}

export function modalShown(cdp) {
  return cdp.ev(`!!(${BTN('确定重新加载')})`);
}

export function modalCancelShown(cdp) {
  return cdp.ev(`!!(${BTN('取消')})`);
}

// —— 设置面板 ——
export async function openSettings(cdp) {
  await cdp.ev(`${BTN('设置')}.click()`);
  await sleep(350);
}

export async function closeSettings(cdp) {
  await cdp.ev(`${BTN('确定')}.click()`);
  await sleep(350);
}

export async function setAutoSaveInterval(cdp, seconds) {
  // [PIT-9] React 受控数字输入：原生 setter + input 事件
  const ok = await cdp.ev(
    `(()=>{const i=document.querySelector('input[type="number"]');if(!i)return false;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'${seconds}');i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`
  );
  await sleep(150);
  return ok;
}

export async function ensureAutoSaveChecked(cdp, wantChecked) {
  // [PIT-10] checkbox 可能已因 localStorage 残留勾选——读 checked 再决定
  return cdp.ev(
    `(()=>{const c=document.querySelector('input[type="checkbox"]');if(!c)return false;const cur=c.checked;if(cur!==${wantChecked}){c.click();}return true;})()`
  );
}
