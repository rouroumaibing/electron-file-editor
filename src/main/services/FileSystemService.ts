// src/main/services/FileSystemService.ts
//
// 所有磁盘操作的唯一汇聚点。前端永远不直接碰 fs（见设计文档 §5 / §2.2）。
// 实现严格遵循约定：
//   - §4.2  工作区根 containment（assertWithinRoot，含不存在路径分支）
//   - §4.3 路径比较归一化（normalizePathForCompare，仅用于比较）
//   - §6  文件预检管线（probeFile，containment 永远是第一步）
//   - §6.2 readFile 链路：containment -> 预检 -> 解码
//   - §5.5 事件源判定（selfWriteTracker）+ 外部 renamed 合成
//   - §7.3 保存乐观并发（readSnapshot + E_CONFLICT，API 层防御）。
//     注意（改版）：渲染层所有保存入口（Cmd+S / 保存按钮 / 关闭保存 / 自动保存）一律传
//     force:true 覆盖写盘，E_CONFLICT 实际不会在 UI 保存路径触发——外部改动的可见性由
//     渲染层非阻塞提示条承担（§8.2），本机制仅作主进程 API 对未来非 UI 调用方的防御。
//   - §5.3 watchId 契约 + §5.6 chokidar 忽略规则（depth:0 / ignoreInitial / 忽略 node_modules/.git）

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { dialog } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import * as iconv from 'iconv-lite';
import type {
  Eol,
  FsChangeEvent,
  FsChangeSource,
  FsChangeType,
  FsError,
  FsErrorCode,
  FileProbe,
  FsResult,
} from '@shared/types/fs';

const KNOWN_CODES = new Set<FsErrorCode>([
  'E_NOENT', 'E_PERM', 'E_EXIST', 'E_ISDIR', 'E_NOTDIR',
  'E_TOOBIG', 'E_ESCAPE', 'E_UNSUPPORTED', 'E_CONFLICT', 'E_INVALID', 'E_UNKNOWN',
]);

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // §6.1
const IMAGE_MAX_SIZE = 20 * 1024 * 1024; // §6.5：图片独立阈值（base64 膨胀 ~33%）
const SELF_WRITE_TTL = 1000; // §5.5：>= 事件通道延迟上限（FSEvents 繁忙可 >500ms）
const RENAME_PAIR_TTL = 200; // §5.5：外部 unlink+add 配对窗口

export class FileSystemService {
  private workspaceRoot: string | null = null;
  private readonly maxFileSize: number;
  private readonly selfWriteTtl: number;

  private seq = 0;
  private watchSeq = 0;

  // §5.5 自写识别器：归一化路径 -> 最近写入时间戳
  private readonly selfWriteTracker = new Map<string, number>();
  // §7.3 乐观并发快照：归一化路径 -> { mtimeMs, size }
  private readonly readSnapshot = new Map<string, { mtimeMs: number; size: number }>();
  // §5.3 watchId -> 取消函数
  private readonly watchers = new Map<string, () => void>();
  // §5.5 外部 rename 合成缓冲：dir|name -> { name, at }
  private readonly deleteBuffer = new Map<string, { name: string; at: number }>();

  private readonly pushEventFn?: (event: FsChangeEvent) => void;

  constructor(opts?: { pushEvent?: (event: FsChangeEvent) => void; maxFileSize?: number }) {
    this.pushEventFn = opts?.pushEvent;
    this.maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.selfWriteTtl = SELF_WRITE_TTL;
  }

  // —— 错误构造（§3.1）——
  private err(code: FsErrorCode, message: string, p?: string): FsError {
    const e: FsError = { code, message };
    if (p !== undefined) e.path = p;
    return e;
  }

  // 把任意异常转成 FsError：已是我们的 FsError（如 E_ESCAPE）则原样返回，
  // 否则按 Node ErrnoException.code 映射到 FsErrorCode。
  private toFsError(e: unknown): FsError {
    if (e && typeof e === 'object' && 'code' in e) {
      const c = (e as { code?: unknown }).code;
      if (typeof c === 'string' && KNOWN_CODES.has(c as FsErrorCode)) {
        return e as FsError;
      }
    }
    const err = e as NodeJS.ErrnoException;
    const map: Record<string, FsErrorCode> = {
      ENOENT: 'E_NOENT', EACCES: 'E_PERM', EPERM: 'E_PERM',
      EISDIR: 'E_ISDIR', ENOTDIR: 'E_NOTDIR', EEXIST: 'E_EXIST',
    };
    const code = err?.code && map[err.code] ? map[err.code] : 'E_UNKNOWN';
    return { code, message: err?.message ?? 'unknown error' };
  }

  // ===== §4.2 containment =====
  private async assertWithinRoot(target: string): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) throw this.err('E_PERM', 'no workspace root set');
    const resolvedRoot = await fs.realpath(root);
    const candidate = path.resolve(root, target);

    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      // 目标不存在（createFile / createDirectory / renameEntry 的新路径场景）：
      // 校验父目录在根内，再拼回文件名（§4.2 实现注意：父目录也可能不存在，向上递归找祖先）
      real = await this.resolveExistingAncestor(candidate);
    }

    const rel = path.relative(resolvedRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      // 错误信息不含 target 真实路径，避免泄露（path 字段仅本地日志用）
      throw this.err('E_ESCAPE', 'path escapes workspace root', target);
    }
  }

  // 递归向上找最近存在的祖先目录，再拼回候选路径的文件名（§4.2 实现注意）
  private async resolveExistingAncestor(candidate: string): Promise<string> {
    let dir = path.dirname(candidate);
    for (;;) {
      try {
        const realDir = await fs.realpath(dir);
        return path.join(realDir, path.basename(candidate));
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return candidate; // 已到文件系统根仍不存在，交由 containment 拒绝
        dir = parent;
      }
    }
  }

  // ===== §4.3 路径比较归一化（仅用于比较，绝不用于寻址）=====
  private normalizePathForCompare(p: string): string {
    let s = path.normalize(p);
    try {
      s = s.normalize('NFC'); // macOS 文件名 NFD/NFC 归一化（中文高频坑）
    } catch {
      /* 老 Node 不支持时忽略 */
    }
    if (process.platform === 'win32') {
      s = s.toLowerCase(); // Windows 大小写不敏感 + 盘符
    }
    return s;
  }

  // ===== §3.6 openDirectoryDialog + §4.2 validateRootCandidate =====
  // 按显式路径设置工作区根（拖拽打开 dropOpen / 未来命令行打开共用）。
  // 与 openDirectoryDialog 的区别：失败返回 FsResult 错误（可提示），而非静默 null。
  async openDirectoryAt(candidate: string): Promise<FsResult<string>> {
    const v = await this.validateRootCandidate(candidate);
    if (!v.ok) return { ok: false, error: v.error };
    this.workspaceRoot = path.resolve(candidate);
    return { ok: true, data: this.workspaceRoot };
  }

  async openDirectoryDialog(): Promise<string | null> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const r = await this.openDirectoryAt(result.filePaths[0]);
    return r.ok ? r.data : null;
  }

  // (重新)设定根之前的准入检查：必须是已存在目录且可读（≠ containment）
  async validateRootCandidate(p: string): Promise<FsResult<void>> {
    try {
      const stat = await fs.stat(p);
      if (!stat.isDirectory()) return { ok: false, error: this.err('E_NOTDIR', 'not a directory') };
      await fs.readdir(p); // 探一次读权限
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  getWorkspaceRoot(): string | null {
    return this.workspaceRoot;
  }

  // ===== §3.6b dropOpen：拖拽打开（目录 → 新工作区；文件 → 打开或自动提升父目录为根）=====
  // 语义与「打开文件夹」按钮一致；路径判定与根切换全部收敛在主进程（前端不碰 fs，§5）。
  //   - 拖入目录：第一个合法目录作为新工作区根（validateRootCandidate 准入）
  //   - 拖入文件：若已在当前根内 → 原样返回打开；否则自动把工作区根切到其父目录
  //   - 返回前按 containment 过滤 files：只保留落在最终根内的文件
  //     （readFile 的 assertWithinRoot 是硬约束，根外文件必然 E_PERM，不必发给渲染层）
  async dropOpen(paths: string[]): Promise<FsResult<import('@shared/types/fs').DropOpenResult>> {
    try {
      const files: string[] = [];
      let root: string | null = null;
      for (const p of paths) {
        let st;
        try {
          st = await fs.stat(p);
        } catch {
          continue; // 不存在 / 无权限条目直接跳过
        }
        const resolved = path.resolve(p);
        if (st.isDirectory()) {
          if (!root) {
            const r = await this.openDirectoryAt(resolved);
            if (r.ok) root = r.data; // 多个目录只取第一个；后续目录忽略
          }
        } else if (st.isFile()) {
          files.push(resolved);
        }
      }
      // 只有文件且不在当前根内（含首启无根）：以第一个文件的父目录为工作区根
      if (!root && files.length > 0) {
        const currentRoot = this.workspaceRoot;
        const inside = currentRoot ? this.isInside(currentRoot, files[0]) : false;
        if (!inside) {
          const r = await this.openDirectoryAt(path.dirname(files[0]));
          if (r.ok) root = r.data;
        }
      }
      const effectiveRoot = root ?? this.workspaceRoot;
      const kept = effectiveRoot ? files.filter((f) => this.isInside(effectiveRoot, f)) : [];
      return { ok: true, data: { root, files: kept } };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  // 粗略 containment 判定（仅 dropOpen 内过滤用）：归一化后的路径前缀比较
  private isInside(root: string, target: string): boolean {
    const r = this.normalizePathForCompare(root);
    const t = this.normalizePathForCompare(target);
    const sep = path.sep;
    return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
  }

  // ===== §5.1 readDirectory（懒加载，只返回一层）=====
  async readDirectory(dirPath: string): Promise<FsResult<import('@shared/types/fs').FileNode[]>> {
    try {
      await this.assertWithinRoot(dirPath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) return { ok: false, error: this.err('E_NOTDIR', 'not a directory') };
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const nodes = entries
        .filter((entry) => !entry.name.startsWith('.')) // MVP：过滤隐藏条目
        .map((entry) => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          loadState: entry.isDirectory() ? ('unloaded' as const) : undefined,
          expanded: false,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { ok: true, data: nodes };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  // ===== §6.1 probeFile（containment 永远是第一步）=====
  async probeFile(filePath: string): Promise<FsResult<FileProbe>> {
    try {
      await this.assertWithinRoot(filePath); // 步骤 0：containment 优先
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) return { ok: false, error: this.err('E_ISDIR', 'cannot preview a directory') };
      const size = stat.size;
      if (size > this.maxFileSize) {
        return { ok: true, data: { size, category: 'large', previewable: false } };
      }

      // 步骤 2：编码判定 —— 只认 BOM，其余一律 UTF-8（不猜测多字节编码，
      // 避免 jschardet 误判导致乱码；UTF-8 无 BOM 是目标工作区约定，见设计文档 §6.1）
      const fd = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, 8192, 0);
      await fd.close();
      const sample = buf.subarray(0, bytesRead);

      const bom = this.detectBom(sample);
      if (bom) {
        return { ok: true, data: { size, category: 'text', encoding: bom, previewable: true } };
      }

      // 无 BOM：扫 NUL 字节判定二进制（UTF-8 纯文本不含 NUL）
      if (sample.includes(0x00)) {
        const mime = this.detectMime(sample);
        return { ok: true, data: { size, category: 'binary', mimeType: mime, previewable: false } };
      }

      // 兜底：无 BOM 且无 NUL -> UTF-8 纯文本（§6.1 步骤 3）
      return { ok: true, data: { size, category: 'text', encoding: 'utf-8', previewable: true } };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  private detectBom(buf: Buffer): string | null {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
    return null;
  }

  private detectMime(sample: Buffer): string {
    if (sample[0] === 0xff && sample[1] === 0xd8) return 'image/jpeg';
    if (sample[0] === 0x89 && sample[1] === 0x50) return 'image/png';
    if (sample[0] === 0x47 && sample[1] === 0x49) return 'image/gif';
    // WebP：RIFF 容器 + 'WEBP' 四字符标记（避免与 RIFF 音频误判）
    if (sample.length >= 12 && sample.toString('ascii', 0, 4) === 'RIFF' && sample.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    if (sample[0] === 0x42 && sample[1] === 0x4d) return 'image/bmp'; // 'BM'
    // ICO：00 00 01 00（保留字 0 + 类型 1）
    if (sample.length >= 4 && sample[0] === 0 && sample[1] === 0 && sample[2] === 1 && sample[3] === 0) {
      return 'image/x-icon';
    }
    return 'application/octet-stream';
  }

  // ===== §6.2 readFile：containment -> 预检 -> 解码 =====
  async readFile(
    filePath: string,
  ): Promise<FsResult<{ content: string; encoding: string; eol: Eol }>> {
    try {
      await this.assertWithinRoot(filePath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    const probe = await this.probeFile(filePath);
    if (!probe.ok) return probe; // 透传 E_ESCAPE / E_NOENT / E_ISDIR
    if (probe.data.category === 'large') return { ok: false, error: this.err('E_TOOBIG', 'file exceeds size limit') };
    if (probe.data.category === 'binary') return { ok: false, error: this.err('E_UNSUPPORTED', 'binary file not previewable') };

    const encoding = probe.data.encoding ?? 'utf-8';
    try {
      const raw = await fs.readFile(filePath);
      let content: string;
      if (encoding === 'utf-8') {
        content = raw.toString('utf-8');
      } else {
        // 仅 BOM 明确的 UTF-16 走 iconv；其余统一按 UTF-8（§6.1 约定）
        try {
          content = iconv.decode(raw, encoding);
        } catch {
          content = raw.toString('utf-8'); // 兜底
        }
      }
      content = content.replace(/^\uFEFF/, ''); // 剥 BOM 字符（U+FEFF，用转义避免源码内嵌不可见字符）

      const eol = this.detectEol(content);

      // §7.3：写入读取快照（mtimeMs + size）
      const stat = await fs.stat(filePath);
      this.readSnapshot.set(this.normalizePathForCompare(filePath), {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });

      return { ok: true, data: { content, encoding, eol } };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  private detectEol(content: string): Eol {
    const hasCRLF = content.includes('\r\n');
    const hasLF = content.includes('\n');
    if (hasCRLF && hasLF) return 'Mixed';
    if (hasCRLF) return 'CRLF';
    return 'LF';
  }

  // ===== §6.5 图片预览数据链：读字节 -> base64 data URL（不进 Monaco）=====
  // 判定不依赖 probeFile 的 category：图片先被 probe 判为 text（如纯文本 SVG）
  // 或未知二进制（如 BMP/ICO 无魔数分支）时，这里仍能按扩展名 + 内容魔数复核，
  // 避免"能点开但预览失败"。
  private readonly imageMimeByExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };

  // 图片判定：二进制魔数优先；SVG 无魔数，走扩展名 + 文本内容复核
  private detectImageMime(ext: string, head: Buffer): string | null {
    const bin = this.detectMime(head);
    if (bin.startsWith('image/')) return bin;
    if (ext === '.svg') {
      const text = head.toString('utf-8').replace(/^\uFEFF/, '').trimStart();
      if (text.startsWith('<svg') || text.startsWith('<?xml')) return 'image/svg+xml';
    }
    return null;
  }

  async readImage(filePath: string): Promise<FsResult<{ dataUrl: string }>> {
    try {
      await this.assertWithinRoot(filePath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return { ok: false, error: this.err('E_ISDIR', 'cannot preview a directory') };
      if (stat.size > IMAGE_MAX_SIZE) {
        return { ok: false, error: this.err('E_TOOBIG', 'image exceeds size limit') };
      }

      const ext = path.extname(filePath).toLowerCase();
      const fd = await fs.open(filePath, 'r');
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fd.read(buf, 0, 64, 0);
      await fd.close();
      const head = buf.subarray(0, bytesRead);

      const mime = this.detectImageMime(ext, head);
      if (!mime) return { ok: false, error: this.err('E_UNSUPPORTED', 'not an image file') };

      const raw = await fs.readFile(filePath);
      const base64 = raw.toString('base64');
      return { ok: true, data: { dataUrl: `data:${mime};base64,${base64}` } };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  // ===== §7.3 writeFile（乐观并发 + force 覆盖）=====
  async writeFile(
    filePath: string,
    content: string,
    opts?: { force?: boolean },
  ): Promise<FsResult<void>> {
    try {
      await this.assertWithinRoot(filePath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      const normPath = this.normalizePathForCompare(filePath);
      const snapshot = this.readSnapshot.get(normPath);
      if (snapshot) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (!opts?.force && stat && (stat.mtimeMs !== snapshot.mtimeMs || stat.size !== snapshot.size)) {
          return { ok: false, error: this.err('E_CONFLICT', 'file modified externally since last read') };
        }
      }
      await fs.writeFile(filePath, content, 'utf-8'); // 按 model.getValue() 已归一化 EOL（§6.3）

      // 成功后立即回写快照（否则连续第二次保存误报 E_CONFLICT）
      const newStat = await fs.stat(filePath);
      this.readSnapshot.set(normPath, { mtimeMs: newStat.mtimeMs, size: newStat.size });
      this.markSelf([filePath]);
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  // ===== §5.2 写操作（成功后标记 self，见 §5.5）=====
  async createFile(filePath: string): Promise<FsResult<void>> {
    try {
      await this.assertWithinRoot(filePath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      if (await this.exists(filePath)) return { ok: false, error: this.err('E_EXIST', 'file already exists') };
      // 支持嵌套路径（如 "sub/dir/foo.ts"）：中间目录缺失时自动创建。
      // containment 已在上方校验整个目标在根内，父目录自然也在根内。
      const parentDir = path.dirname(filePath);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(filePath, '');
      this.markSelf([filePath]);
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  async createDirectory(dirPath: string): Promise<FsResult<void>> {
    try {
      await this.assertWithinRoot(dirPath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      await fs.mkdir(dirPath, { recursive: true });
      this.markSelf([dirPath]);
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  async deleteEntry(entryPath: string): Promise<FsResult<void>> {
    try {
      await this.assertWithinRoot(entryPath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      await fs.rm(entryPath, { recursive: true, force: false });
      this.markSelf([entryPath]);
      this.readSnapshot.delete(this.normalizePathForCompare(entryPath));
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  async renameEntry(oldPath: string, newPath: string): Promise<FsResult<void>> {
    try {
      // §4.2：renameEntry 有两个路径参数，都要 containment
      await this.assertWithinRoot(oldPath);
      await this.assertWithinRoot(newPath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      if (!(await this.exists(oldPath))) return { ok: false, error: this.err('E_NOENT', 'source does not exist') };
      // 自子树守卫：禁止把目录移入自身或自身后代（跨目录拖拽移动的硬约束）。
      // 放在 E_EXIST 之前：自子树场景下目标往往是已存在的后代目录（如 deep → deep/x），
      // 报"不能移进自己"比"目标已存在"准确得多；纯重命名/普通移动的新路径必不存在，
      // 该检查对它们无影响。fs.rename 自身也会拒绝（EINVAL），这里显式拦截以返回可读错误。
      if (newPath === oldPath || newPath.startsWith(oldPath + '/')) {
        return { ok: false, error: this.err('E_INVALID', 'cannot move a directory into itself') };
      }
      if (await this.exists(newPath)) return { ok: false, error: this.err('E_EXIST', 'target already exists') };
      await fs.rename(oldPath, newPath);
      this.markSelf([oldPath, newPath]);

      // §7.3：迁移快照 key（改名后首次保存不应跳过校验/误命中旧路径）
      const normOld = this.normalizePathForCompare(oldPath);
      const snap = this.readSnapshot.get(normOld);
      if (snap) {
        this.readSnapshot.set(this.normalizePathForCompare(newPath), snap);
        this.readSnapshot.delete(normOld);
      }
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  private async exists(p: string): Promise<boolean> {
    return fs.access(p).then(() => true).catch(() => false);
  }

  // ===== §5.5 自写识别器 =====
  private markSelf(paths: string[]): void {
    const now = Date.now();
    for (const p of paths) {
      this.selfWriteTracker.set(this.normalizePathForCompare(p), now);
    }
  }

  private isSelf(p: string): boolean {
    const norm = this.normalizePathForCompare(p);
    const ts = this.selfWriteTracker.get(norm);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.selfWriteTtl) {
      this.selfWriteTracker.delete(norm);
      return false;
    }
    return true;
  }

  // ===== §5.3 watchId 契约 + §5.5 事件源判定 + §5.6 忽略规则 =====
  async watchDir(dirPath: string): Promise<FsResult<{ watchId: string }>> {
    try {
      await this.assertWithinRoot(dirPath);
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
    try {
      const watchId = `w_${++this.watchSeq}`;
      const dispose = this.watchDirectory(dirPath, (event) => this.pushEvent(event));
      this.watchers.set(watchId, dispose);
      return { ok: true, data: { watchId } };
    } catch (e) {
      return { ok: false, error: this.toFsError(e) };
    }
  }

  async unwatchDir(watchId: string): Promise<FsResult<void>> {
    const dispose = this.watchers.get(watchId);
    if (dispose) {
      dispose();
      this.watchers.delete(watchId);
    }
    return { ok: true, data: undefined };
  }

  // 主进程内部 API：渲染层经 watchDir/unwatchDir 间接使用（函数无法跨 IPC，见 §5.3）
  private watchDirectory(dirPath: string, onChange: (e: FsChangeEvent) => void): () => void {
    const watcher: FSWatcher = chokidar.watch(dirPath, {
      depth: 0, // 只监听本目录单层（§5.4）
      ignoreInitial: true,
      // chokidar 4 起移除 useFsEvents：macOS 上始终使用 FSEvents（§5.3）
      ignored: /(^|[/\\])(node_modules|\.git)([/\\]|$)/, // §5.6（字符类内无需转义 /）
    });

    watcher.on('add', (p) => this.handleAdd(p, onChange));
    watcher.on('change', (p) => this.emit('modified', p, 'file', onChange));
    watcher.on('unlink', (p) => this.handleUnlink(p, onChange));
    watcher.on('addDir', (p) => this.emit('created', p, 'directory', onChange));
    watcher.on('unlinkDir', (p) => this.emit('deleted', p, 'directory', onChange));

    return () => {
      void watcher.close();
    };
  }

  private emit(
    type: FsChangeType,
    p: string,
    kind: 'file' | 'directory',
    onChange: (e: FsChangeEvent) => void,
    oldPath?: string,
  ): void {
    const source: FsChangeSource = this.isSelf(p) ? 'self' : 'external';
    onChange({ type, path: p, oldPath, kind, source, seq: 0, at: Date.now() });
  }

  // §5.5 外部 renamed 合成：unlink 记入缓冲，add 时配对（同目录 + 时间窗）
  private handleUnlink(p: string, onChange: (e: FsChangeEvent) => void): void {
    const dir = path.dirname(p);
    const name = path.basename(p);
    const key = `${this.normalizePathForCompare(dir)}|${name}`;
    this.deleteBuffer.set(key, { name, at: Date.now() });
    this.emit('deleted', p, 'file', onChange);
  }

  private handleAdd(p: string, onChange: (e: FsChangeEvent) => void): void {
    const dir = path.dirname(p);
    const name = path.basename(p);
    const key = `${this.normalizePathForCompare(dir)}|${name}`;
    const buffered = this.deleteBuffer.get(key);
    const now = Date.now();
    if (buffered && now - buffered.at < RENAME_PAIR_TTL) {
      this.deleteBuffer.delete(key);
      const oldPath = path.join(dir, buffered.name);
      const source: FsChangeSource = this.isSelf(p) ? 'self' : 'external';
      onChange({ type: 'renamed', path: p, oldPath, kind: 'file', source, seq: 0, at: now });
      return;
    }
    this.emit('created', p, 'file', onChange);
  }

  // 统一补 seq / at 并推送（§3.3）
  private pushEvent(e: FsChangeEvent): void {
    if (!this.pushEventFn) return;
    this.pushEventFn({ ...e, seq: ++this.seq, at: Date.now() });
  }
}
