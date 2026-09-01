// src/main/services/GitStatusService.ts
//
// Git 状态采集（设计文档 §15）。纯增量装饰的数据来源：
//   - §15.1 探测：git rev-parse --show-toplevel（cwd=workspaceRoot）；失败→本次会话关闭功能
//   - 采集：git status --porcelain=v1 -uall --no-renames（porcelain 路径相对 cwd，即 workspaceRoot）
//   - 执行：execFile（禁用 shell:true，防路径注入），cwd 固定为 workspaceRoot
//   - §15.2 节流：主进程侧 ≥2s 最小间隔合并；并发请求合并为同一个 in-flight；不轮询
//   - §15.4 降级：非仓库/无 git → enabled:false；git status 超时 → 沿用旧缓存；零额外开销

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { GitStatusCode, GitStatusEntry, GitStatusSnapshot } from '@shared/types/git';

const THROTTLE_MS = 2000; // §15.2 最小刷新间隔
const TOPLEVEL_TIMEOUT_MS = 3000;
const STATUS_TIMEOUT_MS = 5000;

export class GitStatusService {
  private cache: { root: string; snap: GitStatusSnapshot } | null = null;
  private lastRun = 0;
  private inflight: Promise<GitStatusSnapshot> | null = null;
  private disabledForSession = false;

  async getStatus(workspaceRoot: string): Promise<GitStatusSnapshot> {
    if (this.disabledForSession) {
      return { enabled: false, entries: [], at: Date.now() };
    }
    const now = Date.now();
    // 节流：窗口内直接返回缓存（§15.2）
    if (this.cache && this.cache.root === workspaceRoot && now - this.cache.snap.at < THROTTLE_MS) {
      return this.cache.snap;
    }
    // 并发请求合并为同一个 in-flight（§15.2）
    if (this.inflight) return this.inflight;
    this.inflight = this.compute(workspaceRoot).finally(() => {
      this.inflight = null;
    });
    try {
      const snap = await this.inflight;
      this.cache = { root: workspaceRoot, snap };
      return snap;
    } catch {
      return { enabled: false, entries: [], at: Date.now() };
    }
  }

  private run(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // maxBuffer 设大：含 node_modules 的仓库在 -uall --ignored 下 porcelain 输出常超 1MB
      //（execFile 默认 1MB，超出抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，导致 git 状态采集失败→文件树全绿）。
      execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  private async compute(workspaceRoot: string): Promise<GitStatusSnapshot> {
    // 探测：是否 git 仓库（§15.1）
    try {
      const out = await this.run(['rev-parse', '--show-toplevel'], workspaceRoot, TOPLEVEL_TIMEOUT_MS);
      if (!out.trim()) throw new Error('not a git repo');
    } catch {
      this.disabledForSession = true; // 非仓库/无 git → 本次会话关闭（§15.4 降级）
      return { enabled: false, entries: [], at: Date.now() };
    }

    // 采集：porcelain v1 路径相对 cwd（=workspaceRoot）
    let stdout: string;
    try {
      stdout = await this.run(
        ['status', '--porcelain=v1', '-uall', '--ignored', '--no-renames'],
        workspaceRoot,
        STATUS_TIMEOUT_MS,
      );
    } catch {
      // git status 超时/失败 → 沿用旧缓存（不阻塞文件树任何操作）
      return { enabled: true, entries: this.cache?.snap.entries ?? [], at: Date.now() };
    }

    const entries: GitStatusEntry[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const rest = line.slice(3);
      const code = this.mapCode(xy);
      if (!code) continue;
      // §15.4：仅保留落在 workspaceRoot 内的条目（工作区位于仓库子目录时过滤外层）
      const abs = path.resolve(workspaceRoot, rest);
      if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + path.sep)) continue;
      entries.push({ path: abs, code });
    }
    return { enabled: true, entries, at: Date.now() };
  }

  // porcelain XY → 单字母状态码（§15.1 / §15.3）
  private mapCode(xy: string): GitStatusCode | null {
    if (xy === '??') return 'U'; // untracked
    if (xy === '!!') return 'I'; // ignored -> 单独状态（文件树置灰，对齐 TRAE IDE）
    if (xy === 'DD' || xy === 'AA' || xy[0] === 'U' || xy[1] === 'U') return 'C'; // unmerged/conflicted
    if (xy[0] === 'D' || xy[1] === 'D') return 'D';
    if (xy[0] === 'M' || xy[1] === 'M') return 'M';
    if (xy[0] === 'A' || xy[1] === 'A') return 'A';
    if (xy[0] === 'R' || xy[1] === 'R') return 'R';
    return null;
  }
}
