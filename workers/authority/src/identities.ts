import {organizations} from './github.js';
import {HttpError, requireValue, string} from './http.js';
import type {Namespace, Session} from './domain.js';

export async function identities(
  session: Session,
  fetcher: typeof fetch,
): Promise<Namespace[]> {
  return [
    session.account,
    ...(session.account.source === 'github-user'
      ? await organizations(session, fetcher)
      : []),
  ];
}

export async function authorizeOwner(
  input: unknown,
  session: Session,
  fetcher: typeof fetch,
): Promise<Namespace> {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  const id = string(value.id, 256);
  if (
    !['google', 'github-user', 'github-organization', 'wallet'].includes(
      String(value.source),
    )
  )
    throw new HttpError(400, 'unsupported_identity_source');
  if (value.source === session.account.source && id === session.account.id)
    return session.account;
  if (
    value.source === 'github-organization' &&
    session.account.source === 'github-user'
  ) {
    const org = (await organizations(session, fetcher)).find(
      org => org.id === id,
    );
    if (org) return org;
  }
  throw new HttpError(403, 'owner_not_allowed');
}
