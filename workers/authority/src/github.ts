import {HttpError} from './http.js';
import type {Account, Session} from './domain.js';

export async function githubRequest(
  path: string,
  token: string,
  fetcher: typeof fetch,
): Promise<Response> {
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'monoid-authority',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401)
    throw new HttpError(401, 'github_reauthentication_required');
  if (!response.ok) throw new HttpError(502, 'github_unavailable');
  return response;
}

export async function githubAccount(
  token: string,
  fetcher: typeof fetch,
): Promise<Account> {
  const user = await (
    await githubRequest('/user', token, fetcher)
  ).json<{id?: number; login?: string; type?: string}>();
  if (
    !Number.isSafeInteger(user.id) ||
    user.id! <= 0 ||
    !user.login ||
    user.type !== 'User'
  )
    throw new HttpError(502, 'invalid_github_identity');
  return {id: String(user.id), login: user.login};
}

export async function organizations(
  session: Session,
  fetcher: typeof fetch,
): Promise<Account[]> {
  if (!session.github) throw new HttpError(403, 'github_connection_required');
  const result: Account[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await githubRequest(
      `/user/memberships/orgs?state=active&per_page=100&page=${page}`,
      session.github.token,
      fetcher,
    );
    const rows = await response.json<
      {
        state: string;
        role: string;
        organization: {id: number; login: string};
      }[]
    >();
    for (const row of rows) {
      if (
        row.state === 'active' &&
        row.role === 'admin' &&
        Number.isSafeInteger(row.organization.id) &&
        row.organization.id > 0
      ) {
        result.push({
          id: String(row.organization.id),
          login: row.organization.login,
        });
      }
    }
    if (!response.headers.get('Link')?.includes('rel="next"')) return result;
  }
  throw new HttpError(502, 'github_membership_limit');
}
