import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { ByteAgentError } from '../shared/errors';
import { ABSENT_HASH, sha256 } from '../shared/hash';
import { describeBlock, type BlockReason, type PathPolicy } from './ignore';
import { absolutePath, extensionOf, resolveInWorkspace, toPosix } from './paths';

export interface FileEntry {
  /** Workspace-relative path with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
  ext: string;
}

export interface ScanStats {
  files: number;
  directories: number;
  skipped: Record<BlockReason | 'too_large' | 'symlink', number>;
  /** True when the file limit stopped the scan early. */
  truncated: boolean;
  durationMs: number;
}

export interface FileText {
  path: string;
  text: string;
  hash: string;
  lineCount: number;
  /** 'editor' when the text came from an unsaved editor buffer. */
  source: 'disk' | 'editor';
}

export interface WorkspaceIndexOptions {
  maxFileSizeBytes?: number;
  maxFiles?: number;
  /** Returns the unsaved text of an open document, if there is one. */
  overlay?: (relativePath: string) => string | undefined;
}

interface CachedText {
  size: number;
  mtimeMs: number;
  text: string;
  hash: string;
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'psd',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'db', 'lockb',
]);

const TEXT_CACHE_LIMIT_BYTES = 48 * 1024 * 1024;

/** True when the bytes look like something other than text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < limit; i++) {
    const b = bytes[i] as number;
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious += 1;
  }
  return limit > 0 && suspicious / limit > 0.1;
}

/**
 * The agent's view of the workspace: which files exist and are allowed,
 * and their current content. Content is cached and revalidated against the
 * file's size and modification time on every read.
 */
export class WorkspaceIndex {
  readonly root: string;
  private entries = new Map<string, FileEntry>();
  private readonly cache = new Map<string, CachedText>();
  private cacheBytes = 0;
  private scanned = false;
  private dirty = true;
  private lastStats: ScanStats | undefined;
  private readonly maxFileSizeBytes: number;
  private readonly maxFiles: number;
  private readonly overlay: (relativePath: string) => string | undefined;

  constructor(
    root: string,
    readonly policy: PathPolicy,
    options: WorkspaceIndexOptions = {},
  ) {
    this.root = path.resolve(root);
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 512 * 1024;
    this.maxFiles = options.maxFiles ?? 20000;
    this.overlay = options.overlay ?? (() => undefined);
  }

  /** Marks the file list as possibly out of date (file created, deleted or renamed). */
  markDirty(): void {
    this.dirty = true;
  }

  get stats(): ScanStats | undefined {
    return this.lastStats;
  }

  /** Scans the workspace if it has not been scanned or was marked dirty. */
  async ensureFresh(): Promise<void> {
    if (!this.scanned || this.dirty) await this.refresh();
  }

  async refresh(): Promise<ScanStats> {
    const started = Date.now();
    const stats: ScanStats = {
      files: 0,
      directories: 0,
      skipped: { vcs: 0, default: 0, gitignore: 0, excluded: 0, sensitive: 0, too_large: 0, symlink: 0 },
      truncated: false,
      durationMs: 0,
    };
    this.policy.reset();
    const next = new Map<string, FileEntry>();
    const queue: string[] = [''];

    while (queue.length > 0 && !stats.truncated) {
      const dir = queue.shift() as string;
      let children: Dirent[];
      try {
        children = await fs.readdir(absolutePath(this.root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const rel = dir ? `${dir}/${child.name}` : child.name;
        if (child.isSymbolicLink()) {
          // Links can point outside the workspace or form cycles.
          stats.skipped.symlink += 1;
          continue;
        }
        if (child.isDirectory()) {
          const decision = this.policy.check(rel, true);
          if (!decision.allowed) {
            stats.skipped[decision.reason ?? 'excluded'] += 1;
            continue;
          }
          stats.directories += 1;
          queue.push(rel);
          continue;
        }
        if (!child.isFile()) continue;
        const decision = this.policy.check(rel, false);
        if (!decision.allowed) {
          stats.skipped[decision.reason ?? 'excluded'] += 1;
          continue;
        }
        let stat;
        try {
          stat = await fs.stat(absolutePath(this.root, rel));
        } catch {
          continue;
        }
        if (stat.size > this.maxFileSizeBytes) {
          stats.skipped.too_large += 1;
          continue;
        }
        next.set(rel, { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, ext: extensionOf(rel) });
        if (next.size >= this.maxFiles) {
          stats.truncated = true;
          break;
        }
      }
    }

    // Drop cached text for files that no longer exist.
    for (const key of [...this.cache.keys()]) {
      if (!next.has(key)) this.evict(key);
    }
    this.entries = next;
    this.scanned = true;
    this.dirty = false;
    stats.files = next.size;
    stats.durationMs = Date.now() - started;
    this.lastStats = stats;
    return stats;
  }

  files(): FileEntry[] {
    return [...this.entries.values()];
  }

  get fileCount(): number {
    return this.entries.size;
  }

  has(relativePath: string): boolean {
    return this.entries.has(relativePath);
  }

  /** Text files only; binary files are detected by extension here and by content on read. */
  textFiles(): FileEntry[] {
    return this.files().filter((f) => !BINARY_EXTENSIONS.has(f.ext));
  }

  /**
   * Validates a path from the user or the model and returns it in
   * workspace-relative form. Throws when the path is outside the workspace
   * or blocked by the exclusion policy.
   */
  resolve(input: string, options: { directory?: boolean } = {}): string {
    const rel = resolveInWorkspace(this.root, input);
    const decision = this.policy.check(rel, options.directory ?? false);
    if (!decision.allowed) {
      throw new ByteAgentError(
        decision.reason === 'sensitive' ? 'path_sensitive' : 'path_excluded',
        `"${rel}" is not available to ByteAgent (${describeBlock(decision.reason)}).`,
        { reason: decision.reason },
      );
    }
    // A file inside an excluded directory is excluded too.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = this.policy.check(parts.slice(0, i).join('/'), true);
      if (!parent.allowed) {
        throw new ByteAgentError(
          parent.reason === 'sensitive' ? 'path_sensitive' : 'path_excluded',
          `"${rel}" is not available to ByteAgent (${describeBlock(parent.reason)}).`,
          { reason: parent.reason },
        );
      }
    }
    return rel;
  }

  /** Reads a text file after all safety checks. */
  async readText(input: string): Promise<FileText> {
    const rel = this.resolve(input);
    const unsaved = this.overlay(rel);
    if (unsaved !== undefined) {
      return { path: rel, text: unsaved, hash: sha256(unsaved), lineCount: countLines(unsaved), source: 'editor' };
    }

    const abs = absolutePath(this.root, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ByteAgentError('not_found', `"${rel}" does not exist.`);
    }
    if (stat.isDirectory()) throw new ByteAgentError('invalid_arguments', `"${rel}" is a folder, not a file.`);
    if (stat.size > this.maxFileSizeBytes) {
      throw new ByteAgentError(
        'file_too_large',
        `"${rel}" is ${Math.round(stat.size / 1024)} KB, over the ${Math.round(this.maxFileSizeBytes / 1024)} KB limit.`,
      );
    }
    if (BINARY_EXTENSIONS.has(extensionOf(rel))) throw new ByteAgentError('binary_file', `"${rel}" is a binary file.`);

    const cached = this.cache.get(rel);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { path: rel, text: cached.text, hash: cached.hash, lineCount: countLines(cached.text), source: 'disk' };
    }

    const bytes = await fs.readFile(abs);
    if (looksBinary(bytes)) throw new ByteAgentError('binary_file', `"${rel}" is a binary file.`);
    const text = bytes.toString('utf8');
    const hash = sha256(text);
    this.store(rel, { size: stat.size, mtimeMs: stat.mtimeMs, text, hash });
    return { path: rel, text, hash, lineCount: countLines(text), source: 'disk' };
  }

  /** Returns lines `start` to `end` (1-based, inclusive), clamped to the file. */
  async readLines(input: string, start: number, end: number): Promise<FileText & { startLine: number; endLine: number }> {
    const file = await this.readText(input);
    const lines = file.text.split('\n');
    const from = Math.max(1, Math.min(start, lines.length));
    const to = Math.max(from, Math.min(end, lines.length));
    return { ...file, text: lines.slice(from - 1, to).join('\n'), startLine: from, endLine: to };
  }

  /**
   * Hash of the content a change would be applied on top of: the unsaved
   * editor text when there is one, otherwise the file on disk. Returns
   * ABSENT_HASH when the file does not exist.
   */
  async currentHash(relativePath: string): Promise<string> {
    const unsaved = this.overlay(relativePath);
    if (unsaved !== undefined) return sha256(unsaved);
    try {
      const bytes = await fs.readFile(absolutePath(this.root, relativePath));
      return sha256(bytes.toString('utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT_HASH;
      throw err;
    }
  }

  /** Lists one directory, hiding everything the policy blocks. */
  async listDirectory(input: string): Promise<Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>> {
    const rel = input.trim() === '' || input.trim() === '.' || input.trim() === './' ? '' : this.resolve(input, { directory: true });
    let children: Dirent[];
    try {
      children = await fs.readdir(absolutePath(this.root, rel), { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ByteAgentError('not_found', `"${rel || '.'}" does not exist.`);
      if (code === 'ENOTDIR') throw new ByteAgentError('invalid_arguments', `"${rel}" is a file, not a folder.`);
      throw err;
    }
    const out: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }> = [];
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const isDir = child.isDirectory();
      if (!isDir && !child.isFile()) continue;
      if (!this.policy.check(childRel, isDir).allowed) continue;
      out.push({ name: child.name, path: childRel, type: isDir ? 'directory' : 'file', size: isDir ? undefined : this.entries.get(childRel)?.size });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  }

  /** Forgets cached content for one file, for example after it was changed. */
  invalidate(relativePath: string): void {
    this.evict(toPosix(relativePath));
  }

  /** Updates the file list for one path without a full scan. */
  async refreshPath(relativePath: string): Promise<void> {
    const rel = toPosix(relativePath);
    this.evict(rel);
    // Blocked paths (dependency folders produce thousands of events) cost nothing.
    if (!this.isAllowedDeep(rel)) {
      this.entries.delete(rel);
      return;
    }
    try {
      const stat = await fs.stat(absolutePath(this.root, rel));
      if (stat.isFile() && stat.size <= this.maxFileSizeBytes) {
        this.entries.set(rel, { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, ext: extensionOf(rel) });
        return;
      }
      if (stat.isDirectory()) {
        this.dirty = true;
        return;
      }
      this.entries.delete(rel);
    } catch {
      // Deleted: it may have been a file or a whole folder.
      if (!this.entries.delete(rel)) {
        const prefix = `${rel}/`;
        for (const key of [...this.entries.keys()]) {
          if (key.startsWith(prefix)) {
            this.entries.delete(key);
            this.evict(key);
          }
        }
      }
    }
  }

  private isAllowedDeep(rel: string): boolean {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!this.policy.check(parts.slice(0, i).join('/'), true).allowed) return false;
    }
    return this.policy.check(rel, false).allowed;
  }

  private store(rel: string, entry: CachedText): void {
    this.evict(rel);
    this.cache.set(rel, entry);
    this.cacheBytes += entry.text.length;
    // Oldest entries go first once the cache is over its limit.
    for (const key of this.cache.keys()) {
      if (this.cacheBytes <= TEXT_CACHE_LIMIT_BYTES) break;
      if (key !== rel) this.evict(key);
    }
  }

  private evict(rel: string): void {
    const existing = this.cache.get(rel);
    if (existing) {
      this.cacheBytes -= existing.text.length;
      this.cache.delete(rel);
    }
  }
}

export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}
