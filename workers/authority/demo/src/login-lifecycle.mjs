function canonicalConnection(value) {
  if (!value) return undefined;
  const [namespace, chain, ...addressParts] = value.split(':');
  const address = addressParts.join(':');
  if (!namespace || !chain || !address) return undefined;
  return `${namespace}:${chain}:${namespace === 'eip155' ? address.toLowerCase() : address}`;
}

// This only keeps the demo's displayed wallet coherent with its login. It is
// not authorization: the Authority still verifies every credential remotely.
export class LoginLifecycle {
  connection;
  revision = 0;

  constructor(signedOut = false) {
    this.signedOut = signedOut;
  }

  setConnection(connection) {
    const canonical = canonicalConnection(connection);
    if (canonical === this.connection) return false;
    this.connection = canonical;
    ++this.revision;
    return true;
  }

  resume() {
    this.signedOut = false;
    ++this.revision;
  }

  signOut() {
    this.signedOut = true;
    ++this.revision;
  }

  snapshot() {
    return this.revision;
  }

  isCurrent(revision) {
    return !this.signedOut && revision === this.revision;
  }

  accepts(revision, account) {
    return (
      this.isCurrent(revision) &&
      Boolean(this.connection) &&
      canonicalConnection(`${account.caip2Network}:${account.address}`) ===
        this.connection
    );
  }
}
