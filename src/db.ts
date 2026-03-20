import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
let _dbPathInUse: string | null = null;
const DB_MAX_AGE_MS = 5000;

function resolveDbPath(): string {
  const override = process.env.ANTFARM_DB_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".openclaw", "antfarm", "antfarm.db");
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function closeDbForTests(): void {
  if (_db) {
    try { _db.close(); } catch {}
  }
  _db = null;
  _dbOpenedAt = 0;
  _dbPathInUse = null;
}

export function getDb(): DatabaseSync {
  const now = Date.now();
  const dbPath = resolveDbPath();
  const shouldReuse = _db && _dbPathInUse === dbPath && (now - _dbOpenedAt) < DB_MAX_AGE_MS;
  if (shouldReuse) return _db!;

  closeDbForTests();
  ensureParentDir(dbPath);
  _db = new DatabaseSync(dbPath);
  _dbPathInUse = dbPath;
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatch_state TEXT NOT NULL DEFAULT 'idle',
      finalization_state TEXT NOT NULL DEFAULT 'idle',
      attempt_id TEXT,
      session_key TEXT,
      heartbeat_at TEXT,
      finalized_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const cols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("type")) {
    db.exec("ALTER TABLE steps ADD COLUMN type TEXT NOT NULL DEFAULT 'single'");
  }
  if (!colNames.has("loop_config")) {
    db.exec("ALTER TABLE steps ADD COLUMN loop_config TEXT");
  }
  if (!colNames.has("current_story_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN current_story_id TEXT");
  }
  if (!colNames.has("abandoned_count")) {
    db.exec("ALTER TABLE steps ADD COLUMN abandoned_count INTEGER DEFAULT 0");
  }
  if (!colNames.has("dispatch_state")) {
    db.exec("ALTER TABLE steps ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!colNames.has("finalization_state")) {
    db.exec("ALTER TABLE steps ADD COLUMN finalization_state TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!colNames.has("attempt_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN attempt_id TEXT");
  }
  if (!colNames.has("session_key")) {
    db.exec("ALTER TABLE steps ADD COLUMN session_key TEXT");
  }
  if (!colNames.has("heartbeat_at")) {
    db.exec("ALTER TABLE steps ADD COLUMN heartbeat_at TEXT");
  }
  if (!colNames.has("finalized_at")) {
    db.exec("ALTER TABLE steps ADD COLUMN finalized_at TEXT");
  }

  db.exec("UPDATE steps SET dispatch_state = 'idle' WHERE dispatch_state IS NULL");
  db.exec("UPDATE steps SET finalization_state = 'idle' WHERE finalization_state IS NULL");
  db.exec("UPDATE steps SET dispatch_state = 'queued' WHERE status = 'pending' AND dispatch_state = 'idle'");
  db.exec("UPDATE steps SET dispatch_state = 'running' WHERE status = 'running' AND dispatch_state = 'idle'");
  db.exec("UPDATE steps SET dispatch_state = 'idle' WHERE status IN ('waiting', 'done', 'failed', 'skipped')");

  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("notify_url")) {
    db.exec("ALTER TABLE runs ADD COLUMN notify_url TEXT");
  }
  if (!runColNames.has("run_number")) {
    db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
    db.exec(`
      UPDATE runs SET run_number = (
        SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
      ) WHERE run_number IS NULL
    `);
  }
}

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
}

export function getDbPath(): string {
  return resolveDbPath();
}
