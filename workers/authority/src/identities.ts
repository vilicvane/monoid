import {githubAccount, organizations} from './github.js';
import {HttpError, requireValue, string} from './http.js';
import type {Namespace, Owner, Session} from './domain.js';

const identity = (
  source: Owner['source'],
  account: {id: string; login: string},
): Namespace => ({source, id: account.id, displayName: account.login});

const personalIdentity = (session: Session): Namespace => ({
  source: 'reown',
  id: session.account.id,
  displayName:
    session.account.method === 'wallet'
      ? session.account.login
      : (session.account.email ?? 'Account'),
});

async function connectedGitHub(session: Session, fetcher: typeof fetch) {
  if (!session.github) throw new HttpError(403, 'github_connection_required');
  const account = await githubAccount(session.github.token, fetcher);
  if (account.id !== session.github.account.id)
    throw new HttpError(401, 'github_identity_changed');
  return account;
}

export async function identities(
  session: Session,
  fetcher: typeof fetch,
): Promise<Namespace[]> {
  const result = [personalIdentity(session)];
  if (session.account.method === 'wallet' && session.wallet)
    result.push(identity('wallet', session.wallet));
  if (session.github) {
    result.push(
      identity('github-user', await connectedGitHub(session, fetcher)),
    );
    result.push(
      ...(await organizations(session, fetcher)).map(org =>
        identity('github-organization', org),
      ),
    );
  }
  return result;
}

export async function authorizeOwner(
  input: unknown,
  session: Session,
  fetcher: typeof fetch,
): Promise<Namespace> {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  const id = string(value.id, 256);
  switch (value.source) {
    case 'reown':
      if (id === session.account.id) return personalIdentity(session);
      break;
    case 'wallet':
      if (
        session.account.method === 'wallet' &&
        session.wallet &&
        id === session.wallet.id
      )
        return identity('wallet', session.wallet);
      break;
    case 'github-user': {
      const account = await connectedGitHub(session, fetcher);
      if (id === account.id) return identity('github-user', account);
      break;
    }
    case 'github-organization': {
      await connectedGitHub(session, fetcher);
      const org = (await organizations(session, fetcher)).find(
        org => org.id === id,
      );
      if (org) return identity('github-organization', org);
      break;
    }
    default:
      throw new HttpError(400, 'unsupported_identity_source');
  }
  throw new HttpError(403, 'owner_not_allowed');
}
