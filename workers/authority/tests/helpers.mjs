import {DatabaseSync} from 'node:sqlite';
import {AuthorityStore} from '../.bld/storage.js';

export function database(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  return new AuthorityStore({
    sql: {
      exec(query, ...bindings) {
        if (query.includes('CREATE TABLE')) {
          db.exec(query);
          return;
        }
        const rows = db
          .prepare(query)
          .all(...bindings)
          .map(row => ({...row}));
        return {toArray: () => rows};
      },
    },
  });
}

export async function keyEnv() {
  const pair = await crypto.subtle.generateKey(
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    ['deriveBits'],
  );
  return {
    AUTHORITY_PRIVATE_JWK: JSON.stringify(
      await crypto.subtle.exportKey('jwk', pair.privateKey),
    ),
    BUNDLE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url'),
  };
}
