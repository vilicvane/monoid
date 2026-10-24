import type {Group, Namespace, Owner} from './domain.js';

export class AuthorityStore {
  constructor(private readonly storage: Pick<DurableObjectStorage, 'sql'>) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, proof TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_expiry ON records(expires);
      CREATE TABLE IF NOT EXISTS namespace_names (
        source TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL,
        PRIMARY KEY (source, id)
      );
      CREATE TABLE IF NOT EXISTS groups (
        owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        allow_peer_extension INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_source, owner_id, name)
      );
    `);
  }

  put(key: string, value: string, proof: string, expires: number): void {
    this.storage.sql.exec(
      'INSERT INTO records (key, value, proof, expires) VALUES (?, ?, ?, ?)',
      key,
      value,
      proof,
      expires,
    );
  }

  get(key: string, now: number): string | null {
    return (
      this.storage.sql
        .exec<{
          value: string;
        }>('SELECT value FROM records WHERE key = ? AND expires > ?', key, now)
        .toArray()[0]?.value ?? null
    );
  }

  take(key: string, proof: string, now: number): string | null {
    // Proof and expiry checks are part of consumption, not a separate read/delete.
    return (
      this.storage.sql
        .exec<{
          value: string;
        }>(
          'DELETE FROM records WHERE key = ? AND proof = ? AND expires > ? RETURNING value',
          key,
          proof,
          now,
        )
        .toArray()[0]?.value ?? null
    );
  }

  remove(key: string): void {
    this.storage.sql.exec('DELETE FROM records WHERE key = ?', key);
  }

  namespace(owner: Owner, fallback: string, displayName?: string): Namespace {
    if (displayName !== undefined) {
      this.storage.sql.exec(
        'INSERT INTO namespace_names (source, id, display_name) VALUES (?, ?, ?) ON CONFLICT (source, id) DO UPDATE SET display_name = excluded.display_name',
        owner.source,
        owner.id,
        displayName,
      );
    }
    const row = this.storage.sql
      .exec<{
        display_name: string;
      }>(
        'SELECT display_name FROM namespace_names WHERE source = ? AND id = ?',
        owner.source,
        owner.id,
      )
      .toArray()[0];
    return {...owner, displayName: row?.display_name ?? fallback};
  }

  group(
    owner: Owner,
    name: string,
    policy?: boolean,
    now = Date.now(),
  ): Group | null {
    if (policy !== undefined) {
      this.storage.sql.exec(
        'INSERT OR IGNORE INTO groups (owner_source, owner_id, name, allow_peer_extension, created_at) VALUES (?, ?, ?, ?, ?)',
        owner.source,
        owner.id,
        name,
        policy ? 1 : 0,
        now,
      );
    }

    const row = this.storage.sql
      .exec<{
        allow_peer_extension: number;
        created_at: number;
      }>(
        'SELECT allow_peer_extension, created_at FROM groups WHERE owner_source = ? AND owner_id = ? AND name = ?',
        owner.source,
        owner.id,
        name,
      )
      .toArray()[0];

    return row
      ? {
          name,
          allowPeerExtension: row.allow_peer_extension === 1,
          createdAt: row.created_at,
        }
      : null;
  }

  groups(owner: Owner, after: string): Group[] {
    return this.storage.sql
      .exec<{name: string; allow_peer_extension: number; created_at: number}>(
        'SELECT name, allow_peer_extension, created_at FROM groups WHERE owner_source = ? AND owner_id = ? AND name > ? ORDER BY name LIMIT 100',
        owner.source,
        owner.id,
        after,
      )
      .toArray()
      .map(row => ({
        name: row.name,
        allowPeerExtension: row.allow_peer_extension === 1,
        createdAt: row.created_at,
      }));
  }

  clean(now: number): boolean {
    this.storage.sql.exec('DELETE FROM records WHERE expires <= ?', now);
    return (
      this.storage.sql.exec('SELECT key FROM records LIMIT 1').toArray()
        .length > 0
    );
  }
}
