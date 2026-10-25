import {DatabaseSync} from 'node:sqlite';
import {AuthorityStore} from '../.bld/storage.js';
import {AuthorityCrypto, TIME_PROTOCOL} from '../.bld/crypto.js';
import {encode} from '../.bld/encoding.js';

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

export function cryptoState() {
  const keys = AuthorityCrypto.generateMaterial().then(material =>
    AuthorityCrypto.create(material),
  );
  return {
    metadata: async () => ({
      publicKey: encode((await keys).publicKey),
      bundle: 'hpke-auth-p256-sha256-aes128gcm',
      time: TIME_PROTOCOL,
    }),
    issueTime: async (...args) => (await keys).issueTime(...args),
    issueBundle: async (...args) => (await keys).issueBundle(...args),
    sealSession: async value => (await keys).sealSession(value),
    openSession: async value => (await keys).openSession(value),
  };
}
