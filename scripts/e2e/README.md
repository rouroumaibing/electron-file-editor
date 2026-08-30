# file-editor E2E（CDP 驱动 UI 测试）

Electron + electron-vite + React/Monaco 渲染层的端到端行为测试，通过 Chrome DevTools
Protocol（CDP）驱动真实 dev 实例做合成输入与 DOM 断言。**零 npm 依赖**（Node ≥ 22
原生 WebSocket + fetch），测试脚本不引入任何新包。

## 用法

```bash
npm run e2e                 # 全自动：注入钩子 → 启动 dev → 跑场景 → 还原清理
npm run e2e -- --keep-ws    # 结束后保留 /tmp/eif-e2e-ws 供人工复现
```

运行约 90–120s（dev 冷启动 ~35s + 自动保存场景的真实定时器等待）。

流程自包含、可中断恢复：

1. 在 `FileSystemService.openDirectoryDialog` 注入临时 `EIF_AUTO_DIR` 钩子（env 指定
   目录时绕过系统 dialog，**测试后自动还原原文**，启动时若发现上次中断残留会先自愈还原）
2. 在 `/tmp/eif-e2e-ws` 准备测试工作区（hello.txt / readme.md）
3. spawn `electron-vite dev`（剥离环境残留变量，见 PIT-2），等 CDP 9222 就绪
4. 依次跑 5 个场景，断言计数汇总
5. finally + `process.on('exit')` 双重兜底：还原钩子、停 dev、清理工作区

失败时输出 dev 日志末 50 行帮助定位。退出码非 0 表示有失败断言。

## 文件结构

| 文件 | 职责 |
|---|---|
| `run.mjs` | 主编排：钩子注入/还原、dev 生命周期、5 个场景套件、兜底清理 |
| `cdp-client.mjs` | CDP WebSocket 客户端：connect / eval / waitFor / 合成键鼠输入 |
| `app-helpers.mjs` | 应用层 UI 操作：打开文件夹/文件、Monaco 编辑、dirty/反馈/提示条断言、设置面板 |
| `util.mjs` | sleep / 断言计数器 |

## 覆盖场景

| 场景 | 验证点 |
|---|---|
| S1 手动保存 | 编辑 → 工具栏保存 → 底部「保存成功」→ 磁盘写入 → dirty 清除 |
| S2 重新加载二次确认 | dirty + 外部修改 → 提示条双按钮 → 点重载 → modal（含文件名文案）→ 取消（状态全保留）→ 再点 → 确定（加载外部版本、dirty/提示条清除） |
| S3 保留当前版本 | 外部修改 → 保留 → 提示条消失、dirty 不清 → 保存 force 覆盖外部（无拒绝） |
| S4 自动保存 | 设置开启（间隔 2s）→ 编辑 → 定时器 →「自动保存成功」→ 落盘 + dirty 清除 → 2.5s 反馈消失 → 无 dirty 不提示 → 关自动保存 → 手动保存「保存成功」互不污染 |
| S5 clean 自动重载回归 | clean 文件外部修改 → 直接重载（无提示条 / 无 modal） |

## 已知坑清单（历次排障沉淀，改脚本前必读）

### 环境 / 启动

- **PIT-1 冷启动慢**：dev 启动 ~30–40s，`Cdp.connect` 轮询 `/json/list` 等 page target。
- **PIT-2 环境变量残留**：`ELECTRON_RUN_AS_NODE=1` 会让 Electron 以 Node 模式跑
  （`electron.app undefined` 崩溃）；`CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR` /
  `CODEBUDDY_TOOL_CALL_ID` 会让 vite 清 `out/` 被 safe-delete 拦截。spawn 前必须删除
  这三个变量。
- **PIT-2b 受限环境需禁沙箱**：WorkBuddy 受限执行环境里 Chromium 沙箱初始化失败
  （`sandbox initialization failed: Operation not permitted` → GPU 崩溃 → FATAL），
  必须注入 `ELECTRON_DISABLE_SANDBOX=1` 并传 `--no-sandbox --disable-gpu`（e2e /
  screenshots 已内置；dev-daemon `start --daemon` 在受限环境需手动注入）。
- **PIT-2c `ps`/`pkill` 可能被沙箱拦截**：受限环境 `ps -axww` 报
  `operation not permitted` → 依赖进程枚举的命令（dev-daemon `status` / `stop`、
  killDev 的 `pkill -f`）会误报"未运行/未发现"、进程残留。脚本收尾若发现 dev 已停但
  自身进程不退出（stdio pipe 句柄未释放），需外部强杀；钩子还原不受影响（finally +
  `process.on('exit')` 双重兜底）。用户本机终端无此问题。
- **PIT-3 CDP 取值**：`Runtime.evaluate` 必须 `returnByValue: true` 才拿得到值。
- **PIT-11 React 未挂载**：dev 刚起来页面 React 尚未挂载，按钮不存在——先
  `waitFor` 工具栏按钮再点击。

### Monaco（版本演进大坑，0.56 已变）

- **PIT-5 输入区类名**：Monaco 0.56 输入区是 `.ime-text-area`（非旧版 `.inputarea`），
  且**直接 `focus()` 会破坏输入态导致 insertText 被吞**——必须 `dispatchMouseEvent`
  真实点击内容区后再输入。
- **PIT-6 初始化窗口**：Monaco 刚挂载 ~1.2s 内输入会被吞，`waitEditor` 内含稳定 sleep。
- **PIT-7 NBSP 规范化**：CDP `insertText` 的前导空格会被 Monaco 转为 U+00A0，断言不能
  依赖 ASCII 空格（用 `includes('TEXT')` 而非 `includes(' TEXT')`）；本套件编辑文本
  一律不带前导空格。
- **PIT-12 合成键**：`Input.dispatchKeyEvent` 需带 `windowsVirtualKeyCode` +
  `nativeVirtualKeyCode` 才触发 Monaco 的 `addCommand`（如 End、Cmd+S）。
- **PIT-13 model 复用**：Monaco 按绝对路径复用 model 且不读盘——跨进程/脚本残留会污染
  测试（打开文件夹也不 dispose）。完整重跑前重启 dev 清内存；套件内同一文件用
  「编辑→保存→再编辑」演进，不依赖重开读盘。

### UI 选择器

- **PIT-4 树行**：节点文本是 `📄 {name}`（emoji 前缀），可点击行是 style 含 `cursor`
  的 div（li 容器点击无效）。
- **PIT-8 dirty 标记**：tab 是 `<span>`（非 div），标记字符 `' •'` 有变体
  （`[•●◦]`），匹配时限定 `textContent.length < 40` 排除整棵子树。
- **PIT-9 React 受控输入**：设置面板数字输入需原生 setter
  `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`
  + `dispatchEvent(new Event('input', { bubbles: true }))` 才触发 onChange。
- **PIT-10 checkbox 残留**：checkbox 初始态可能因 localStorage 残留已勾选——先读
  `checked` 再决定是否点击。
- **PIT-16 localStorage 残留会污染 dirty 场景（严重）**：设置面板把 autoSaveEnabled /
  interval 持久化在 localStorage。若上次测试/手工操作残留「自动保存开启」，定时器会在
  你制造 dirty 后 2s 内抢先保存、清掉 dirty，外部修改判定从「提示条」降级为「自动重载」，
  提示条场景全部失效。**套件开局必须 `localStorage.clear()` + `location.reload()`**
  （run.mjs 的 `resetRendererState` 已处理）。
- **PIT-17 `el.click()` 无返回值**：`el?.click() !== undefined` 恒为 false，判断点击
  是否成功要用 `(()=>{const el=...;if(!el)return false;el.click();return true;})()`。
- **PIT-18 selfWriteTracker TTL（严重）**：FileSystemService §5.5 `SELF_WRITE_TTL=1000ms`
  ——应用保存/写盘后 1s 内对同一路径的**外部写也会被 `isSelf()` 误判为 self**（走 self
  分支，提示条/自动重载都不触发）。套件里「先保存、后测外部修改」同一文件时，外部写
  前必须 `sleep(1500)` 等 TTL 过期（run.mjs S2/S3 已处理）。

### 时序

- **PIT-14 自动保存抢 dirty**：间隔设 1s 时定时器会在编辑后立即保存、清掉 dirty，
  吞掉 dirty 观测窗口——测试间隔 ≥2s，或手动路径先关自动保存。
- **PIT-15 外部修改等待**：watcher（chokidar）→ IPC → 渲染层提示条有延迟，`waitFor`
  给足 5s；clean 文件外部修改走自动重载（§8.2），要测提示条必须先制造 dirty。

## 排障提示

- 断言失败先看是否是**已知坑**（尤其 NBSP / dirty 选择器 / 时序竞争），再怀疑产品 bug。
- 场景套件连续跑同一文件（model 复用设计）：单场景失败重跑整个 suite 即可，**不要**
  先跑调试脚本再跑套件（会污染 model）。
- 需要人工介入时可 `--keep-ws` 保留工作区，并在 `run.mjs` 末尾临时加 `sleep` 防退出。
