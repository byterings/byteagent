import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import type { TaskState, TaskTracker } from '../agent/taskState';
import type { Logger } from '../shared/logger';
import { nullLogger } from '../shared/logger';
import type { RunRecord } from '../tools/types';

export const SCHEMA_VERSION = 1;
const SAVE_DELAY_MS = 400;
const MAX_EVENTS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  criteria TEXT NOT NULL,
  steps TEXT NOT NULL,
  files TEXT NOT NULL,
  notes TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  session_id TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  is_check INTEGER NOT NULL,
  output_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_task ON verifications(task_id, id);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ext TEXT NOT NULL,
  hash TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
`;

export interface StoredEvent {
  id: number;
  taskId?: string;
  sessionId?: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface StoredVerification {
  id: number;
  taskId?: string;
  sessionId?: string;
  command: string;
  status: string;
  exitCode: number | null;
  durationMs: number;
  isCheck: boolean;
  outputSummary: string;
  createdAt: number;
}

export interface StoredFile {
  path: string;
  size: number;
  mtimeMs: number;
  ext: string;
  hash?: string;
}

export interface StoredSymbol {
  path: string;
  name: string;
  kind: string;
  line: number;
}

export interface StoreOptions {
  /** Where the database file lives. */
  path: string;
  /** Location of sql.js's WebAssembly binary. */
  wasmPath: string;
  logger?: Logger;
}

let sqlPromise: { wasmPath: string; promise: Promise<SqlJsStatic> } | undefined;

function loadSql(wasmPath: string): Promise<SqlJsStatic> {
  if (sqlPromise?.wasmPath !== wasmPath) {
    const wasmBinary = readFileSync(wasmPath);
    sqlPromise = { wasmPath, promise: initSqlJs({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer }) };
  }
  return sqlPromise.promise;
}

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * The structured, provider-independent record of a project: tasks, what
 * happened to them, verification evidence and the file index. The database
 * is held in memory and written to disk as a whole shortly after each
 * change.
 */
export class ProjectStore implements TaskTracker {
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;
  /** Set when an unreadable database was moved aside on open. */
  recoveredFrom: string | undefined;

  private constructor(
    private db: Database,
    private filePath: string,
    private readonly logger: Logger,
  ) {}

  static async open(options: StoreOptions): Promise<ProjectStore> {
    const logger = options.logger ?? nullLogger;
    const SQL = await loadSql(options.wasmPath);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await fs.readFile(options.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    let db: Database | undefined;
    let recoveredFrom: string | undefined;
    if (bytes && bytes.length > 0) {
      try {
        db = new SQL.Database(bytes);
        db.exec('SELECT count(*) FROM sqlite_master');
      } catch (err) {
        // Keep the unreadable file for the user instead of destroying it.
        recoveredFrom = `${options.path}.unreadable-${Date.now()}`;
        await fs.rename(options.path, recoveredFrom).catch(() => undefined);
        logger.error(`The project database could not be read and was moved to ${recoveredFrom}`, err);
        db = undefined;
      }
    }
    const fresh = !db;
    db = db ?? new SQL.Database();
    db.exec(SCHEMA);
    const store = new ProjectStore(db, options.path, logger);
    store.recoveredFrom = recoveredFrom;
    const version = Number(store.getMeta('schema_version') ?? 0);
    if (version > SCHEMA_VERSION) {
      logger.warn(`The project database was written by a newer ByteAgent (schema ${version}).`);
    } else if (version < SCHEMA_VERSION) {
      store.setMeta('schema_version', String(SCHEMA_VERSION));
    }
    if (fresh) store.setMeta('created_at', String(Date.now()));
    return store;
  }

  get path(): string {
    return this.filePath;
  }

  // ───────────────────────── tasks ─────────────────────────

  save(task: TaskState): void {
    this.db.run(
      `INSERT INTO tasks (id, title, goal, mode, status, criteria, steps, files, notes, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, goal = excluded.goal, mode = excluded.mode, status = excluded.status,
         criteria = excluded.criteria, steps = excluded.steps, files = excluded.files, notes = excluded.notes,
         session_id = excluded.session_id, updated_at = excluded.updated_at`,
      [
        task.id,
        task.title,
        task.goal,
        task.mode,
        task.status,
        JSON.stringify(task.criteria),
        JSON.stringify(task.steps),
        JSON.stringify(task.files),
        JSON.stringify(task.notes),
        task.sessionId ?? null,
        task.createdAt,
        task.updatedAt,
      ],
    );
    this.touch();
  }

  get(id: string): TaskState | undefined {
    return this.query('SELECT * FROM tasks WHERE id = ?', [id]).map(toTask)[0];
  }

  list(): TaskState[] {
    return this.query('SELECT * FROM tasks ORDER BY updated_at DESC, id DESC').map(toTask);
  }

  deleteTask(id: string): void {
    this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
    this.db.run('DELETE FROM events WHERE task_id = ?', [id]);
    this.db.run('DELETE FROM verifications WHERE task_id = ?', [id]);
    this.touch();
  }

  // ───────────────────────── events and evidence ─────────────────────────

  recordEvent(event: { taskId?: string; sessionId?: string; type: string; data?: Record<string, unknown>; at?: number }): void {
    this.db.run('INSERT INTO events (task_id, session_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)', [
      event.taskId ?? null,
      event.sessionId ?? null,
      event.type,
      JSON.stringify(event.data ?? {}),
      event.at ?? Date.now(),
    ]);
    // Old history is trimmed so the file cannot grow without bound.
    this.db.run('DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - ?', [MAX_EVENTS]);
    this.touch();
  }

  events(filter: { taskId?: string; limit?: number } = {}): StoredEvent[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const rows = filter.taskId
      ? this.query('SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', [filter.taskId, limit])
      : this.query('SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id', [limit]);
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: (row.task_id as string | null) ?? undefined,
      sessionId: (row.session_id as string | null) ?? undefined,
      type: String(row.type),
      data: parseJson<Record<string, unknown>>(row.data, {}),
      createdAt: Number(row.created_at),
    }));
  }

  verifications(filter: { taskId?: string; limit?: number } = {}): StoredVerification[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const rows = filter.taskId
      ? this.query('SELECT * FROM (SELECT * FROM verifications WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', [filter.taskId, limit])
      : this.query('SELECT * FROM (SELECT * FROM verifications ORDER BY id DESC LIMIT ?) ORDER BY id', [limit]);
    return rows.map((row) => ({
      id: Number(row.id),
      taskId: (row.task_id as string | null) ?? undefined,
      sessionId: (row.session_id as string | null) ?? undefined,
      command: String(row.command),
      status: String(row.status),
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      durationMs: Number(row.duration_ms),
      isCheck: Number(row.is_check) === 1,
      outputSummary: String(row.output_summary),
      createdAt: Number(row.created_at),
    }));
  }

  /** Stores what a run actually did: file outcomes as events, commands as evidence. */
  recordRun(run: { sessionId?: string; taskId?: string; record: RunRecord; status: string; mode: string; providerId?: string; model?: string }): void {
    const { record } = run;
    const base = { taskId: run.taskId, sessionId: run.sessionId };
    const acted = record.applied.length + record.rejected.length + record.stale.length + record.failed.length + record.commands.length > 0;
    if (!acted && !run.taskId) return;
    this.recordEvent({ ...base, type: 'run', data: { status: run.status, mode: run.mode, providerId: run.providerId, model: run.model } });
    if (record.applied.length > 0) this.recordEvent({ ...base, type: 'changes_applied', data: { paths: [...new Set(record.applied)] } });
    if (record.rejected.length > 0) this.recordEvent({ ...base, type: 'changes_rejected', data: { paths: [...new Set(record.rejected)] } });
    if (record.stale.length > 0) this.recordEvent({ ...base, type: 'changes_stale', data: { paths: [...new Set(record.stale)] } });
    for (const failure of record.failed) this.recordEvent({ ...base, type: 'change_failed', data: { ...failure } });
    for (const command of record.commands) {
      this.db.run(
        'INSERT INTO verifications (task_id, session_id, command, status, exit_code, duration_ms, is_check, output_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [run.taskId ?? null, run.sessionId ?? null, command.command, command.status, command.exitCode, command.durationMs, command.verification ? 1 : 0, command.outputSummary, Date.now()],
      );
    }
    this.touch();
  }

  // ───────────────────────── file index and symbols ─────────────────────────

  /** Replaces the stored file list with the given one, keeping known hashes of unchanged files. */
  saveFiles(files: StoredFile[]): void {
    const known = new Map(this.query('SELECT path, size, mtime_ms, hash FROM files').map((r) => [String(r.path), r]));
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.db.run('DELETE FROM files');
      const statement = this.db.prepare('INSERT INTO files (path, size, mtime_ms, ext, hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const file of files) {
        const previous = known.get(file.path);
        const unchanged = previous && Number(previous.size) === file.size && Number(previous.mtime_ms) === file.mtimeMs;
        statement.run([file.path, file.size, file.mtimeMs, file.ext, file.hash ?? (unchanged ? ((previous.hash as string | null) ?? null) : null), now]);
      }
      statement.free();
      // Symbols of files that no longer exist are dropped with them.
      this.db.run('DELETE FROM symbols WHERE path NOT IN (SELECT path FROM files)');
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.touch();
  }

  fileCount(): number {
    return Number(this.query('SELECT count(*) AS n FROM files')[0]?.n ?? 0);
  }

  getFile(filePath: string): StoredFile | undefined {
    const row = this.query('SELECT * FROM files WHERE path = ?', [filePath])[0];
    if (!row) return undefined;
    return { path: String(row.path), size: Number(row.size), mtimeMs: Number(row.mtime_ms), ext: String(row.ext), hash: (row.hash as string | null) ?? undefined };
  }

  listFiles(): StoredFile[] {
    return this.query('SELECT * FROM files ORDER BY path').map((row) => ({
      path: String(row.path),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      ext: String(row.ext),
      hash: (row.hash as string | null) ?? undefined,
    }));
  }

  replaceSymbols(filePath: string, symbols: Array<Omit<StoredSymbol, 'path'>>): void {
    this.db.run('DELETE FROM symbols WHERE path = ?', [filePath]);
    if (symbols.length > 0) {
      const statement = this.db.prepare('INSERT INTO symbols (path, name, kind, line) VALUES (?, ?, ?, ?)');
      for (const symbol of symbols) statement.run([filePath, symbol.name, symbol.kind, symbol.line]);
      statement.free();
    }
    this.touch();
  }

  findSymbols(name: string, limit = 50): StoredSymbol[] {
    return this.query('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE ORDER BY (name = ?) DESC, path LIMIT ?', [name, name, limit]).map((row) => ({
      path: String(row.path),
      name: String(row.name),
      kind: String(row.kind),
      line: Number(row.line),
    }));
  }

  symbolCount(): number {
    return Number(this.query('SELECT count(*) AS n FROM symbols')[0]?.n ?? 0);
  }

  // ───────────────────────── meta and persistence ─────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.query('SELECT value FROM meta WHERE key = ?', [key])[0];
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
    this.touch();
  }

  /** Writes pending changes to disk now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) this.write();
    await this.saving;
  }

  /** Moves the database file to a new location and keeps using it there. */
  async relocate(newPath: string): Promise<void> {
    if (path.resolve(newPath) === path.resolve(this.filePath)) return;
    await this.flush();
    const old = this.filePath;
    this.filePath = newPath;
    this.dirty = true;
    await this.flush();
    await fs.rm(old, { force: true }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.db.close();
  }

  private touch(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.write();
    }, SAVE_DELAY_MS);
  }

  private write(): void {
    if (this.closed) return;
    this.dirty = false;
    const bytes = this.db.export();
    const target = this.filePath;
    // Writes are chained so two never overlap, and each replaces the file atomically.
    this.saving = this.saving
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temp, bytes);
        await fs.rename(temp, target);
      })
      .catch((err) => {
        this.dirty = true;
        this.logger.error('Could not save the project database', err);
      });
  }

  private query(sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
    const statement = this.db.prepare(sql);
    const rows: Array<Record<string, SqlValue>> = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }
}

function toTask(row: Record<string, SqlValue>): TaskState {
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    mode: row.mode === 'quick' || row.mode === 'standard' ? row.mode : 'project',
    status: (['planning', 'in_progress', 'paused', 'done', 'failed', 'cancelled'] as const).find((s) => s === row.status) ?? 'paused',
    criteria: parseJson<string[]>(row.criteria, []),
    steps: parseJson<TaskState['steps']>(row.steps, []),
    files: parseJson<Record<string, string>>(row.files, {}),
    notes: parseJson<string[]>(row.notes, []),
    sessionId: (row.session_id as string | null) ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
