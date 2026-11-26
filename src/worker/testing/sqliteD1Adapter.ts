import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { D1Database, D1Meta, D1PreparedStatement, D1Result } from '../types/bindings';

function makeMeta(changes: number, lastRowId = 0, rowsRead = 0): D1Meta {
  return {
    duration: 0,
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: changes,
  };
}

class SqlitePreparedStatement implements D1PreparedStatement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly sql: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const stmt = new SqlitePreparedStatement(this.db, this.sql);
    stmt.boundValues = values.map((v) => (v === undefined ? null : v));
    return stmt;
  }

  private normalizeSqlAndParams(): { sql: string; params: unknown[] } {
    const orderedParams: unknown[] = [];
    const normalizedSql = this.sql.replace(/\?(\d+)/g, (_match, indexStr) => {
      const idx = Number(indexStr) - 1;
      orderedParams.push(this.boundValues[idx] ?? null);
      return '?';
    });

    if (orderedParams.length === 0 && this.boundValues.length > 0) {
      return { sql: this.sql, params: this.boundValues };
    }

    return { sql: normalizedSql, params: orderedParams };
  }

  executeSync<T = Record<string, unknown>>(): D1Result<T> {
    const { sql, params } = this.normalizeSqlAndParams();
    const stmt = this.db.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    const hasReturning = /\bRETURNING\b/i.test(sql);

    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH')) {
      const rows = stmt.all(...params) as T[];
      return {
        results: rows,
        success: true,
        meta: makeMeta(0, 0, rows.length),
      };
    }

    if (hasReturning) {
      const rows = stmt.all(...params) as T[];
      return {
        results: rows,
        success: true,
        meta: makeMeta(rows.length, 0, rows.length),
      };
    }

    const info = stmt.run(...params);
    return {
      results: [],
      success: true,
      meta: makeMeta(info.changes, Number(info.lastInsertRowid ?? 0), 0),
    };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const { sql, params } = this.normalizeSqlAndParams();
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.executeSync<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.executeSync<T>();
  }
}

export class SqliteD1Adapter implements D1Database {
  public readonly rawDb: Database.Database;

  constructor(filename = ':memory:') {
    this.rawDb = new Database(filename);
    this.rawDb.pragma('foreign_keys = ON');
  }

  prepare(query: string): D1PreparedStatement {
    return new SqlitePreparedStatement(this.rawDb, query);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[]
  ): Promise<D1Result<T>[]> {
    const runTx = this.rawDb.transaction((stmts: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const s of stmts) {
        results.push((s as SqlitePreparedStatement).executeSync<T>());
      }
      return results;
    });

    return runTx(statements);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = Date.now();
    this.rawDb.exec(query);
    return { count: 1, duration: Date.now() - start };
  }

  applyMigrations(migrationsDir: string): void {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      this.rawDb.exec(sql);
    }
  }

  close(): void {
    this.rawDb.close();
  }
}
