import type { D1Database, D1PreparedStatement, D1Result } from '../types/bindings';
import { DatabaseError } from '../lib/errors';

export async function executeAtomicBatch(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<D1Result[]> {
  if (statements.length === 0) {
    return [];
  }
  try {
    return await db.batch(statements);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`D1 atomic batch failed: ${msg}`);
  }
}
