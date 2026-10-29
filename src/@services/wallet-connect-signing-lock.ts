import {SSHProtocolError, SSH_ERROR_CODES} from '@monoid/ssh-protocol';

/** Covers approval and the complete card operation, including cancelled work. */
export class WalletConnectSigningLock {
  private owner: symbol | undefined;

  acquire(): () => void {
    if (this.owner) throw new SSHProtocolError(SSH_ERROR_CODES.busy);
    const owner = Symbol();
    this.owner = owner;
    return () => {
      if (this.owner === owner) this.owner = undefined;
    };
  }
}
