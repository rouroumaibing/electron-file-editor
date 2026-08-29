// cdp-client.mjs — CDP WebSocket 客户端（零依赖）
//
// 使用 Node >= 22 原生 WebSocket + fetch，无需安装 ws 包。
// 已知坑注释（完整清单见 scripts/e2e/README.md）：
//   [PIT-1] dev 冷启动 ~30-40s，connect() 必须轮询 /json/list 等 page target 出现
//   [PIT-2] Electron 环境变量残留（ELECTRON_RUN_AS_NODE=1 / CODEBUDDY_SAFE_DELETE_*）
//           由 run.mjs 在 spawn 前过滤，本模块不关心
//   [PIT-3] Runtime.evaluate 结果要 returnByValue: true 才拿得到值
import { sleep } from './util.mjs';

export { sleep };

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(`CDP ${m.id} ${m.error.message}`));
      else resolve(m.result);
    };
  }

  // 等待 9222 CDP 端口出现 page target 并建立连接
  static async connect(port = 9222, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
          return new Cdp(ws);
        }
      } catch (e) { lastErr = e; }
      await sleep(1000);
    }
    throw new Error(`CDP :${port} 未在 ${timeoutMs / 1000}s 内就绪${lastErr ? `（最后错误: ${lastErr.message}）` : ''}`);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 页面内求值并返回值；表达式抛错时给出可读信息（调试友好）
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`page eval 异常: ${desc}`);
    }
    return r.result?.value;
  }

  // 轮询等待页面内条件成立（默认 250ms 间隔）
  async waitFor(name, expression, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.ev(expression)) { console.log(`  ✓ ${name}`); return true; }
      } catch { /* 表达式内部报错视为未满足 */ }
      await sleep(250);
    }
    console.log(`  ✗ waitFor 超时: ${name}（${timeoutMs}ms）`);
    return false;
  }

  // 合成键盘事件：Monaco 的 addCommand 需要 windowsVirtualKeyCode + nativeVirtualKeyCode 才触发
  async key(kind, key, code, vk) {
    const p = { type: kind, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', p);
  }

  async pressKey(key, code, vk) {
    await this.key('keyDown', key, code, vk);
    await this.key('keyUp', key, code, vk);
  }

  async insertText(text) {
    await this.send('Input.insertText', { text });
  }

  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  close() {
    try { this.ws.close(); } catch { /* noop */ }
  }
}
