# Monoid Authority

Cloudflare Worker providing authenticated Bundle enrollment and challenge-bound
time proofs. AppKit / ReownAuthentication is the primary login. Optional GitHub
OAuth connects organization permissions to the current session.

This implementation includes the Worker, hosted sign-in page, authorization-code
and PKCE interfaces, protocol/OAuth tests and workerd tests. The last deployment recorded here
at `https://authority.monoid.app` is version
`482cd348-5e3a-41bd-9c68-8757c2836b67` (2026-10-25). Both Authority secrets were
replaced by keys generated inside the Durable Object; the old Worker Secrets and
local private recovery file were removed. Live checks verified the new time
signature and stable public key after secret-removal deployments, plus login
creation/cancellation without key environment bindings. The public key SHA-256 is
`670715b03702f37aea1ec44d97699b0428d87c8ccb2874e2bb6a04419265550d`.
Earlier HTTPS/asset and fresh-Chrome GitHub navigation checks also passed. A complete
authenticated production login remains unverified.
The APP now uses this hosted login with PKCE and
`app.monoid://authority/callback` for Authority bundle enrollment (see
[APP design record 84](../../.agents/project-memory/84.md)). This package owns the
Worker and hosted page; native callback/device acceptance is a separate check.
The optional demo remains a diagnostic tool. The Bundle format follows the
current sibling Java Card
[`authority.md`](../../../monoid-javacard/doc/authority.md).

The production Authority uses AppKit project
`aec3500aba9026d07588b3b244c402c7` for browser login. The Monoid APP's WalletKit
project is `f1bac1f17e8531e322bd69250c6cc7b4`; it serves wallet connectivity and
remains separate. Changing the Authority configuration does not change the APP's
WalletKit project. Reown personal namespace IDs include the AppKit project ID,
so retain this choice for production identity continuity.

## Identity and bundles

- Reown owner: `{source: "reown", id: "<Reown project ID>:<profileUuid>"}`.
  The Worker obtains this from Reown's authenticated `/auth/v1/me` endpoint;
  it never accepts client identity claims or an unverified decoded JWT.
- Wallet owner: `{source: "wallet", id: "<chainNamespace>:<address>"}`. Only the
  wallet verified by the current Reown SIWX session is eligible, and only when
  the session method is `wallet`; never for `email` or `social`. Linked-wallet
  metadata does not authorize an owner. EVM addresses are lowercase; other address encodings
  preserve case. The chain namespace separates networks with different address
  semantics; EVM networks intentionally share the same address identity.
- GitHub personal owner: `{source: "github-user", id: "<GitHub numeric user ID>"}`.
  Requires the separately connected GitHub account; its username can change.
- Organization owner: `{source: "github-organization", id: "<GitHub numeric org ID>"}`.
  Current active organization **Owner** membership (`role=admin`) is required.
  Ordinary membership is insufficient. GitHub identity and membership are
  checked again for every organization issuance or bundle listing.
- Under each owner, the user chooses `groupName`: case sensitive, NFC Unicode,
  1–128 UTF-8 bytes, no surrounding whitespace, control or format characters.
- The first issuance fixes `allowPeerExtension` for that owner/name. A different
  policy returns 409; use another bundle name for another policy.

The permanent namespace identity is the pair `(source, id)`, not its display
name. `GET /v1/namespaces` discovers currently authorized namespaces, including
their `displayName`. `POST /v1/namespaces/name {owner, displayName}` changes only
the stored label (same text validation as bundle names), never root derivation
or policy. Identical names are allowed across different identities and confer no
rights. Display the source alongside the name in the APP. Names of shared wallet
and organization namespaces are shared: any currently authorized controller can
rename them. Unset labels follow the provider's current display name/address.

These four sources are supported now. Other providers need a verified-identity
adapter; self-managed organizations and membership administration are not
implemented. Unsupported source names fail closed. No email/name-based merging
or implicit aliasing occurs between Reown, wallet and GitHub identities.

Names of GitHub accounts/organizations and email addresses do not determine
roots. Accounts are not merged by matching email or display name. Reown profile
continuity across wallet changes, social-account linking and project migration
must be verified with the configured project before production enrollment.
Losing that profile identity can prevent reissuance of a personal Bundle.

## Hosted login protocol and APP integration

The Worker and hosted page implement the following protocol used by the APP.
The APP calls Authority groups **bundles**; wire names such as `groupName`,
`groups` and `/v1/groups/list` remain unchanged.

Use the same account row in the hosted page and APP. The implementation is
[`web/src/account.tsx`](web/src/account.tsx): copy its `PROVIDER_NAMES`,
`AccountRow`, `Symbol` and `AccountCard` verbatim, changing only imports to the
APP's local UI leaves and the account type. The row uses the Card Applets pattern
from `src/@components/views/card/card-management-content.tsx`. `Symbol` is private
there, so this package copies that exact style: 36×36px, 9px radius, primary
background, white 28px `AppIcon`. The remaining pieces are imported shared
components, including the trailing `IconButton` (32px hit area).

`AccountRow` uses `ListItem` with `align-items: center`, a 12px item gap, 2px
content gap and 20px name line height. Row padding is zero inside the fieldset's
own padding. Names have `min-width: 0`, `overflow-wrap: anywhere` and
`text-wrap: pretty`; `Address` has `width: 100%`. Long email values wrap; wallet
addresses use the shared middle ellipsis with the full value in `title` and
`aria-label`. The APP must retain these styles with the markup below.

| Method | Icon        | Name                                           | Description           |
| ------ | ----------- | ---------------------------------------------- | --------------------- |
| email  | `Mail`      | verified email; `Signed in.` if absent         | Email                 |
| social | `UserRound` | verified email; `<Provider> account` if absent | provider display name |
| wallet | `Wallet`    | verified login in `Address`                    | Wallet                |

Provider display names are Google, X, GitHub, Discord, Apple, Facebook and
Farcaster. Neither embedded method ever falls back to the wallet address.
`icon`, `name` and `description` below follow that table. Exact shared markup:

```tsx
<InfoFieldset>
  <InfoLegend>Signed in as</InfoLegend>
  <AccountRow>
    <Symbol>
      <AppIcon icon={icon} aria-hidden="true" />
    </Symbol>
    <ListItemContent>
      <ListItemName>
        {account.method === 'wallet' ? (
          <Address title={account.login} aria-label={account.login}>
            {account.login}
          </Address>
        ) : (
          name
        )}
      </ListItemName>
      <ListItemDescription>{description}</ListItemDescription>
    </ListItemContent>
    <IconButton
      aria-label="Use another account"
      disabled={busy}
      onClick={onChange}
    >
      <AppIcon icon={ArrowLeftRight} aria-hidden="true" />
    </IconButton>
  </AccountRow>
</InfoFieldset>
```

Cancellation immediately returns to Monoid. If the browser stays open, show
`<InfoMessage>Sign-in cancelled.</InfoMessage>` and one neutral `Back to Monoid`
button, with no completion graphic. Only approval shows `OperationComplete`
with `label="Signed in"`, followed by `Return to Monoid to continue.`. The
optional label belongs only to this page's completion adapter; the APP's
component is unchanged.

1. The client creates random state and a PKCE verifier, then POSTs
   `/auth/login/start` with
   `{redirectUri, state, codeChallenge: base64url(SHA256(verifier)),
codeChallengeMethod: "S256"}`. The redirect must exactly match the allowlist.
   The client must retain its state, verifier and expiry locally until completion
   or cancellation; the verifier never goes into the authorization URL.
2. The client opens the returned authorization URL in the system browser.
   The Worker consumes that request, binds a ten-minute flow to an HttpOnly
   browser cookie, and opens `/login`. This is the production page in `web/`,
   built with the APP's shared UI styles/components. AppKit runs on this page.
3. The page obtains the configured Reown project from the Worker and uses
   AppKit + `ReownAuthentication`. Wallet connection alone is insufficient:
   complete the authenticated SIWX flow. Social/email login may create an
   embedded wallet; it is not the Java Card identity or the Authority key.
   The browser sends the Reown credential directly to the Worker, which verifies
   it remotely. Provider credentials never cross the APP callback.
4. The browser returns to the original allowlisted callback with only a one-use
   code and state. `app.monoid://authority/callback` is the APP callback.
   The client must check the exact callback and state, then POST
   `/auth/login/token {code, codeVerifier, redirectUri}` within 60 seconds.
   Code redemption is atomic and bound to both PKCE and the original redirect.
   The client must reject cancelled, expired, duplicate and unrelated callbacks.
5. The client receives an opaque Authority bearer and can call `/v1/namespaces`.
   A session expires after five minutes without an authenticated request.
   Successful bearer authentication renews that idle window, within a fixed
   cap of 15 minutes from verified sign-in or the provider expiry, whichever
   comes first. Token response `expiresIn` is the remaining idle window in
   seconds (at most 300), not the full absolute lifetime. Renewal and GitHub
   token rotation never reset the absolute cap. Public requests and failed
   authentication do not renew it; expired sessions return 401.
   The APP keeps the bearer in memory and clears
   pending-login metadata after completion or cancellation.
6. The APP clears its bearer and calls `/auth/logout` on completion, leaving
   the flow, hiding the app and after five idle minutes. Logout removes the
   server session; an in-flight provider verification cannot restore a revoked
   or expired session. Protected operations revalidate Reown remotely and fail
   closed on provider errors.

The browser sign-in also ends on approval or cancellation. After obtaining the
redirect URL, the page immediately clears its project-scoped SIWX auth/nonce
keys and stops accepting account updates, starts `siwx.setSessions([])` and
`appkit.disconnect()` (after `appkit.ready()`), then returns to Monoid **without
awaiting** SDK cleanup. Late SIWX session events erase credentials again. If the
browser suspends before disconnect finishes, the next flow clears these keys
again and uses `enableReconnect: false`, which disconnects cached connections
instead of restoring them. Other projects' SIWX keys are untouched.

These calls were checked in the installed AppKit **1.8.24** source:

- `web/node_modules/@reown/appkit-controllers/dist/esm/src/features/siwx/reown-authentication/ReownAuthentication.js`:
  `setSessions([])` clears the configured auth/nonce keys and OTP state. It does
  not revoke the provider JWT needed for the pending Authority code exchange.
- `web/node_modules/@reown/appkit/dist/esm/src/client/appkit-base-client.js`:
  public `ready()` waits for initialization; `disconnect()` uses the active
  connector, and `enableReconnect: false` clears existing connections at startup.
- `web/node_modules/@reown/appkit-adapter-ethers/dist/esm/src/client.js` and
  `web/node_modules/@reown/appkit-wallet/dist/esm/src/W3mFrameProvider.js`:
  an AUTH connector disconnect clears embedded-wallet login caches and sends
  `APP_SIGN_OUT` to its frame. Its response can take up to three seconds, so it
  must not delay the callback. SIWX cleanup is explicit because disconnect alone
  does not always clear ReownAuthentication credentials.

Native system-browser launch, warm/cold callback handling, pending-flow storage
and platform callback registration belong to the APP. Allowlist entries alone
do not register a handler or establish device acceptance.

Bundle enrollment uses the selected `{source, id}` as `owner`, chooses a bundle
name and its immutable peer-extension policy, and completes login before NFC. It must read the card's Identity public key, request
`/v1/bundle`, authenticate the Secret PIN, pass decoded `{publicKey, data}` to
Join Bundle `0x24`, and verify the returned Bundle SHA-256. The card must already
trust this Authority key. Never automatically replay an uncertain card operation.

GitHub connection (optional backend flow; future APP client sequence):

1. APP generates cryptographically random `state` (22–128 base64url characters)
   and a PKCE verifier (43–128 RFC 7636 characters); retain both in memory.
2. With its Authority bearer, POST `/auth/github/start` containing
   `{redirectUri, state, codeChallenge: base64url(SHA256(verifier))}`. The URI must
   exactly match an operator-configured allowlist entry.
3. Open the returned `authorizationUrl` in the system browser. Worker uses a
   separate upstream PKCE verifier, one-use state and HttpOnly browser cookie.
   After GitHub authorization the browser asks the user to confirm connecting
   the displayed GitHub account to the initiating Monoid session.
4. Return through the allowlisted APP URI with a one-use code and state. APP
   checks state and POSTs `/auth/token {code, codeVerifier}` within 60 seconds.
   Replace the old bearer with the returned bearer; the old one is invalidated.
   GitHub access tokens never reach the APP and are not retained after session
   expiry. AppKit's GitHub social login alone does **not** grant GitHub API
   organization access. Native custom schemes require PKCE; prefer verified
   HTTPS app links once mobile association files are available.

The provider verification path mirrors AppKit 1.8.24's public SDK implementation
of `ReownAuthentication.getSessionAccount()`, including the required
`st=appkit` and `sv=html-ethers-1.8.24` query parameters. Omitting either causes
an upstream 403 before credential validation. Such a rejection fails closed as
a service error, separately from a 401 requiring reauthentication.
Real GitHub social login, JWT verification and namespace discovery were verified
with the local test project on 2026-10-24. This does not establish a separately
guaranteed backend API contract or production project readiness. Configure the
exact hosted-page origin in `REOWN_AUTH_ORIGINS`; its browser creates the SIWX
message even when the initiating client is a native APP. Do not weaken the
origin check to accommodate an unexplained mismatch.

References: [AppKit SIWX](https://docs.reown.com/appkit/react/core/siwx),
[ReownAuthentication](https://docs.reown.com/appkit/react/core/reown-authentication),
[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## HTTP API

### Account and sign-in method

`POST /auth/login/complete` requires exactly
`{flow: string, token: string, method: "wallet" | "email" | "social", provider?: string}`.
Missing or invalid methods return `400 invalid_sign_in_method`; extra fields
(including email, address or profile claims) return `400 invalid_login_request`.
`provider` is **required for social** and must be one of `google`, `github`,
`apple`, `facebook`, `x`, `discord`, `farcaster`. It must be **absent for email
and wallet**. Missing, wrong-case, unknown or non-string social providers, and
any provider on another method (including null), return
`400 invalid_sign_in_provider` without consuming the flow. The list matches
AppKit 1.8.24's `SocialProvider` union in
`web/node_modules/@reown/appkit-common/dist/types/src/utils/TypeUtil.d.ts` and
`DEFAULT_SOCIALS` in `@reown/appkit-controllers/dist/esm/src/utils/ConstantsUtil.js`;
a contract test checks it against the installed SDK. The hosted chooser retains
its configured Google/GitHub/Apple choices; the API accepts all seven SDK values.
The diagnostic `/auth/reown` exchange uses `{token, method, provider?}` with the
same validation.
Neither endpoint accepts an email as an identity claim.

`POST /auth/login/token` returns
`{accessToken, tokenType: "Bearer", expiresIn, account}`; `GET /v1/me` returns
`{account}`. Both use this exact account shape:

```ts
{
  id: string; // unchanged: <Reown project ID>:<verified profile UUID>
  login: string; // unchanged: verified SIWX address, including for embedded wallets
  method: 'wallet' | 'email' | 'social';
  email?: string; // nonempty string from the verified Reown /auth/v1/me response
  provider?: 'google' | 'github' | 'apple' | 'facebook' | 'x' | 'discord' | 'farcaster'; // social only
}
```

Do not display `login` for email/social sign-ins. Display the verified `email`;
if Reown supplies none, use the shared row's fallback above without falling back
to the embedded address. Wallet sign-ins display `login`, even if an email is also
present. Revalidation refreshes `login` and `email` from Reown while retaining
the session's method and provider. Email/provider never determines identity,
namespace IDs or roots.

The hosted page reads AppKit 1.8.24's `getAccount('eip155')` and subscribes with
`subscribeAccount(..., 'eip155')`. Verified against the installed source:
`web/node_modules/@reown/appkit/dist/esm/src/client/appkit-base-client.js`,
`getAccount()` (lines 1820–1868), and the `UseAppKitAccountReturn` type in
`@reown/appkit-controllers/dist/types/src/utils/TypeUtil.d.ts`.
`embeddedWalletInfo` is supplied only for the active `AUTH` connector;
`embeddedWalletInfo.authProvider === 'email'` selects `email`, other social
provider strings select `social`, and a connected account without that metadata
selects `wallet`. An incomplete embedded provider is not classified as a wallet.
The social provider is read from that same `embeddedWalletInfo.authProvider`.
Address, method or provider changes invalidate pending profile verification; Continue
rechecks the current selection and credential before submission.

**Method/provider are client-asserted presentation and eligibility metadata, not
verified proof of a sign-in mechanism or a social identity.** They only change how the signed-in user's own
namespaces are presented and offered; it grants no identity or additional
ownership. A caller asserting `wallet` still has to prove that exact wallet via
the existing remote SIWX validation and cannot choose someone else's wallet.
Do not use this field as an attestation that a wallet is externally held.
Provider only chooses the row's label; it does not grant GitHub organization
access, change ownership or authorize anything. Social sessions/pending codes
without a valid stored provider require a fresh sign-in (`401
reown_reauthentication_required`); none is inferred from an email or address.

Only `wallet` sessions list or authorize a Wallet owner, including bundle
listing, namespace renaming and bundle issuance. Email/social sessions retain
the same Reown owner; its default label is the verified email, or `Account`
when absent. User-assigned namespace labels remain intact. Profile UUID,
project/origin/expiry checks, SIWX address verification, PKCE, cookies and root
derivation are unchanged. No accounts are merged by email or method.

Sessions or pending codes created before method metadata require a new sign-in
(`401 reown_reauthentication_required`); no method is inferred for them. Durable
namespace labels and bundle policies are not migrated or removed.
Sessions or pending codes created before the idle policy also require a new
sign-in (`401 unauthorized`): they lack the internal fixed `absoluteExpiresAt`
cap and are not renewed. That field is not part of the HTTP account shape.

Production base: `https://authority.monoid.app`, with API and login endpoints at
the origin root, for example `/v1/metadata`, `/auth/login/start` and `/login`.
Local development retains the base `http://localhost:8787/api/authority`.
All bytes use canonical unpadded base64url. JSON request bodies are limited to
4096 bytes. Responses are no-store.
Errors are `{error: string}` with 400/401/403/409/413/429/502/503 as applicable.
Unknown internal failures return sanitized 500 without credential logging.

| Method / path               | Authentication               | Input / response                                                                                                                 |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET `/v1/metadata`          | Public                       | Authority public key, Bundle algorithm and `time: {protocol, version, algorithm}`                                                |
| POST `/v1/time`             | Public, rate limited         | `{challenge}` → `{publicKey, data, signature}`                                                                                   |
| POST `/auth/reown`          | Reown JWT in body            | `{token, method, provider?}` → `{accessToken, tokenType, expiresIn, account}`                                                    |
| POST `/auth/login/start`    | Public, rate limited         | `{redirectUri, state, codeChallenge, codeChallengeMethod: "S256"}` → `{authorizationUrl, expiresIn}`                             |
| GET `/auth/login`           | One-use request              | Consumes request, sets browser cookie, redirects to hosted `/login`                                                              |
| GET `/login`                | Public page                  | Production sign-in UI; requires a valid browser-bound flow to authenticate                                                       |
| GET `/auth/login/context`   | Flow + browser cookie        | `?flow=...` → `{projectId, expiresAt}`                                                                                           |
| POST `/auth/login/complete` | Same Origin + browser cookie | `{flow, token, method, provider?}` → `{redirectUrl}` containing one-use code/state                                               |
| POST `/auth/login/cancel`   | Same Origin + browser cookie | `{flow}` → `{redirectUrl}` containing cancellation/state                                                                         |
| POST `/auth/login/token`    | Code + PKCE + redirect       | `{code, codeVerifier, redirectUri}` → `{accessToken, tokenType, expiresIn, account}`                                             |
| GET `/v1/me`                | Authority bearer             | `{account}`                                                                                                                      |
| GET `/v1/organizations`     | Bearer + GitHub connection   | `{organizations: [{id, login}]}`                                                                                                 |
| POST `/v1/groups/list`      | Bearer + owner permission    | `{owner, after?}` → `{owner, groups, next}`; at most 100 rows                                                                    |
| POST `/v1/bundle`           | Bearer + owner permission    | `{owner, groupName, allowPeerExtension, recipientPublicKey}` → `{publicKey, data, bundle, owner, groupName, allowPeerExtension}` |
| POST `/auth/github/start`   | Authority bearer             | PKCE/redirect/state as above → `{authorizationUrl, expiresIn}`                                                                   |
| GET `/auth/github`          | One-use request              | Browser-only GitHub redirect                                                                                                     |
| GET `/auth/github/callback` | State + browser cookie       | Browser confirmation form                                                                                                        |
| POST `/auth/approve`        | Browser cookie + same Origin | Redirects to APP with code/state                                                                                                 |
| POST `/auth/token`          | Code + PKCE                  | Rotated Authority session response                                                                                               |
| POST `/auth/logout`         | Authority bearer             | 204; invalidates local session                                                                                                   |

## Cryptographic formats

Namespace discovery and rename endpoints:

- `GET /v1/namespaces` (Authority bearer) returns
  `{namespaces: [{source, id, displayName}]}` for currently verified identities.
- `POST /v1/namespaces/name` (Authority bearer and owner permission) accepts
  `{owner: {source, id}, displayName}` and returns `{namespace}`. It changes only
  the display name. `/v1/groups/list` and `/v1/bundle` accept the same owner shape.

One P-256 key serves HPKE Auth and ECDSA time signing. A separate random 32-byte
master secret derives roots using HMAC-SHA256 over UTF-8 `JSON.stringify` of:

```text
["Monoid Authority Bundle Root", 1, owner.source,
 owner.id, NFC(groupName), allowPeerExtension]
```

`displayName` is deliberately excluded. Changing
this canonical derivation changes all affected roots. Preserve this deployed
schema and use an explicit migration for future identity or derivation changes.
HPKE uses RFC 9180 Auth,
DHKEM(P256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, empty AAD and fresh enc per
issuance. The 182-byte packet is verified by an independent test receiver.

Time proof v1:

```text
data = 01 || unixSeconds_u64_bigEndian || challenge[32]  // 41 bytes
signature = ECDSA-P256-SHA256("Monoid Authority Time" || data)
```

The signature is 64-byte IEEE P1363 `r || s`, not DER. The verifier must generate
and retain a fresh challenge, pin the Authority public key, reject reused or
unexpected challenges and impose a delay/freshness policy. A nonce alone does
not prevent delayed delivery or establish a continuously trustworthy clock.
This is a service protocol proposal; firmware does not yet consume it.

The metadata describes the service protocol, not client firmware capabilities:
`time.protocol` is `monoid-authority-time`, `version` is `1`, and `algorithm` is
`ecdsa-p256-sha256-p1363`. APP/card compatibility belongs to the client capability
negotiation. The service does not expose `timeCardSupport`.

The Authority knows Bundle roots and can issue another recipient or decrypt
captured Bundle artifacts. Revoking online access prevents future issuance,
not use of an existing offline Bundle/packet. No card expiry or remote revocation
is implied. No recipient attestation is provided: an authorized owner can ask
for issuance to any valid P-256 public key, including a software-held one.

## Keys, configuration and migration

The Authority Durable Object generates its P-256 identity and independent
32-byte Bundle master inside the Workers runtime, then persists both in its
private Cloudflare storage. Initialization is serialized and commits the complete
key record atomically. Later requests, object restarts and ordinary deployments
reuse that record; there is no automatic rotation, key import or export endpoint.
Only the public key, signatures, encrypted Bundle packets and normal session
results leave the cryptographic operations.

The storage record contains a private JWK and master bytes because workerd cannot
serialize `CryptoKey` objects into Durable Object storage. The object imports
non-extractable WebCrypto keys for use in memory. Raw material stays within the
Durable Object's storage/runtime and is not returned by its RPC interface,
written to logs, provisioned as Worker Secrets, or backed up on a local machine.
This is software isolation, not an HSM guarantee: someone with deployment
control could change the code to read and disclose the persisted material.

The transition from the initial imported keys was explicitly approved as a
replacement of both secrets. It changes the Authority public key and every
derived Bundle root. Initialization invalidates the old short-lived sessions and
login grants while preserving namespace labels and bundle policies. Clients must
sign in again; cards that pinned the previous public key need an explicit trust
update. Existing offline Bundles remain usable under their old roots and are not
remotely revoked. The old Worker Secrets and local recovery copy are retired as
part of this rollout; they must not be reused as fallback keys.

Do not put `AUTHORITY_PRIVATE_JWK` or `BUNDLE_MASTER_KEY` in `.dev.vars`, Wrangler
secrets or deployment input. `GITHUB_CLIENT_SECRET` is unrelated optional OAuth
configuration and can still be provisioned through Wrangler's secret input or
the dashboard. Never print it in shell history, logs, chat or committed files.

Set `GITHUB_CLIENT_ID` when organization support is enabled; callback URL is
`<AUTHORITY_URL>/auth/github/callback`. GitHub organization OAuth restrictions/SSO
may require administrator approval; inaccessible membership fails closed.
Set exact `APP_REDIRECT_URIS`, `APP_ORIGINS` and `REOWN_AUTH_ORIGINS` JSON arrays.
The checked-in configuration contains callback allowlist entries
`app.monoid://authority/callback` and `https://www.monoid.app/authority`;
API CORS origins are listed separately in `APP_ORIGINS`. These are protocol configuration; the APP registers and handles its native
callback separately.
The hosted page and Worker share `https://authority.monoid.app`, which is the
Reown authentication origin. The AppKit project must have **Social & Email** and
**Reown Authentication** enabled and permit that origin. Read-only preflight on
2026-10-25 confirmed both features enabled for
`aec3500aba9026d07588b3b244c402c7` using the production Origin and Referer.
`https://authority.monoid.app` was then explicitly added to the project's Domain
allowlist. An empty allowlist passes the AppKit connectivity check but leaves
the embedded wallet's CSP restricted to development hosts, causing social login
to stall. Verify the `/sdk` response's `frame-ancestors` includes the production
origin; that response may remain in browser cache for 24 hours after an early
failed attempt. The Worker independently restricts SIWX authentication to the
same origin. Complete production login still requires end-to-end verification.
`APP_ORIGINS` is `["*"]`: the API answers CORS for any origin, while browser login and approval endpoints still require the Authority origin. Never add wildcard redirect URLs or Reown origins.

Keep the Durable Object namespace, object name and key record stable. Deleting
the object/storage, changing its namespace or rolling storage back before key
creation can lose the identity and lead to newly generated keys. A point-in-time
restore also rewinds bundle policies and short-lived records, potentially
restoring previously consumed codes or revoked sessions. Restore the key record
and related state together, invalidate sessions after recovery, and verify the
public key against the expected public fingerprint before resuming enrollment.
Do not reset storage or use point-in-time recovery as a routine deployment step.

There is no off-platform key backup or export workflow under this policy.
Moving to another provider therefore requires a new Authority identity and
client/card enrollment unless a different migration policy is explicitly
approved later. Reown project/profile IDs are also part of personal identities:
changing provider/project requires an explicit identity migration, not automatic
email matching. The public metadata may be retained outside Cloudflare for trust
verification; it contains no private key material.

SQLite Durable Object `authority` stores policies and short-lived login records.
Provider tokens are encrypted with AES-GCM under a domain-separated key derived
from the master. Random bearer/code keys are stored hashed. Proof validation and
code consumption use one atomic SQL statement; expired login records are cleaned
by an hourly alarm only while records remain. Bundle policies remain durable.

## Validation and rollout

### Local development

```sh
# Repository root: the hosted page imports the APP's shared UI implementation.
npm ci
cd workers/authority
npm ci
npm --prefix web ci
npm run dev:init
npm run dev
```

`dev:init` creates an ignored `.dev.vars` containing only localhost and OAuth
settings, using AppKit project `aec3500aba9026d07588b3b244c402c7`. It does not
generate keys or overwrite an existing file. The existing local
`.dev.vars` remains on development AppKit project
`0bcfe1f323c1f7234a1fba3d77491aea`. Existing files retain their configured project
and OAuth settings. Remove obsolete `AUTHORITY_PRIVATE_JWK` and
`BUNDLE_MASTER_KEY` entries from older development configurations; they are no
longer inputs. Change the project setting only when deliberately changing the
development identity space. The
default local URL is `http://localhost:8787/api/authority`. `npm run dev` builds
the production page into `web/dist` and serves it through the Worker's `ASSETS`
binding alongside the API. Wrangler uses local
SQLite under `.wrangler/state`; no cloud deployment is needed. The local Durable
Object generates and persists separate development keys on first use. Do not
copy local persistence into production or install its public key on production
cards. After prototype schema changes, use a new local persistence directory
(`npm run dev -- --persist-to .wrangler/state-namespaces`) if an older database
already exists; this does not remove the old state.

For page changes, run `npm run dev:web` in another `workers/authority` terminal;
it watches the shared page build while Wrangler serves it on port 8787.
Open **http://localhost:8787/api/authority/login** directly to inspect the page;
without a valid flow it explains that login must first be initiated by a client.
Starting the Monoid APP is not required to serve or inspect this page.

Interactive authorization requires a client to call `/auth/login/start`, retain
its state/verifier and open the returned `authorizationUrl`. The Worker does not
create an unbound login or an APP callback handler when `/login` is opened
directly. Backend tests exercise this flow without an APP. Allow
`http://localhost:8787` in both `REOWN_AUTH_ORIGINS` and the development Reown
project. Use `localhost`, not `127.0.0.1`, for the configured local login flow.

The development server listens on all IPv4 interfaces at port 8787. This allows
page/API inspection from the network if the host firewall permits it, but the
generated authorization URLs and authentication allowlists still use localhost.
Full login from another device needs a reachable HTTPS development origin,
matching `AUTHORITY_URL`, exact origin/redirect allowlists and a callback client.
A phone's `localhost` is not the development computer. Native APP launch and
callback acceptance must be checked on the target devices.

For a quick check, open `/v1/metadata`. To request a time proof in PowerShell:

```powershell
$challenge = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
Invoke-RestMethod http://localhost:8787/api/authority/v1/time -Method Post -ContentType application/json -Body (@{challenge=$challenge} | ConvertTo-Json)
```

### Optional diagnostic demo

This is the earlier diagnostic surface, not the production login page and not
the APP's browser handoff. It intentionally exposes namespace/time tools.

Keep the Worker running and start the demo in a second terminal, from
`workers/authority`:

```sh
npm --prefix demo ci
npm run demo
```

Open **http://localhost:5173/**. Use `localhost`, not `127.0.0.1`; origins must
match exactly. Set `VITE_REOWN_PROJECT_ID` in ignored `demo/.env.local` to the
same `REOWN_PROJECT_ID` as the local Worker's ignored `.dev.vars`, then restart
both local servers. The existing development configuration uses
`0bcfe1f323c1f7234a1fba3d77491aea`; newly generated configuration defaults to
`aec3500aba9026d07588b3b244c402c7`. Both sides must agree. The hosted production
page instead obtains the configured project directly from the Worker.
Project IDs are public identifiers; switching projects changes Reown namespace
IDs. Signing in requires network access to Reown and the selected wallet or
social provider. There is no authentication bypass or fake local login.

The selected AppKit project has Social & Email and Reown Authentication enabled.
Configure these in Reown Dashboard, not WalletConnect Dashboard. Missing
`social_login` overrides the demo's local email/social options. The Worker
additionally enforces its own explicit origin checks.

Choose **使用 AppKit 登录**, complete the identity signature, and the demo
automatically exchanges the Reown credential with the local Worker. It displays
the authorized first-level namespaces with their source, permanent ID and
editable display name. **同步登录状态** restores/retries the exchange. Switching
the active wallet invalidates the previous Authority session until the new
wallet is authenticated. Explicit logout blocks late AppKit events from signing
the demo back in; only a new login/sync action resumes authentication.

The Authority bearer stays in memory. ReownAuthentication manages its own JWT
and nonce in localStorage under `monoid-authority-demo:<project ID>:reown-auth`
and `monoid-authority-demo:<project ID>:reown-nonce`. Credentials and signed-out
state are isolated by project. Logout clears those keys, disconnects AppKit
and requests Authority session revocation. A sessionStorage flag records the
explicit signed-out state across reloads; it contains no credential.

**连接 GitHub** is optional. Configure a development OAuth app in `.dev.vars`
with callback `http://localhost:8787/api/authority/auth/github/callback`, then
restart Wrangler. The demo uses a popup and returns to
`http://localhost:5173/authority/callback`, already in the generated dev
allowlist. Its callback loads no AppKit SDK, clears the query string, and sends
the one-use code only to the initiating same-origin window. The opener checks
origin, popup identity and state before PKCE exchange.

The login page sends an origin-only HTTP Referer: Reown rejects its `/sdk`
iframe with HTTP 400 when that header is omitted. The GitHub callback retains
`no-referrer`; neither page sends OAuth query parameters to external services.

**请求并验签** works without login: it generates a random challenge and verifies
the returned time proof using WebCrypto. The demo reads the public key from the
same local endpoint; this tests protocol correctness, not independently pinned
Authority trust. This demo has no Java Card/NFC or Bundle enrollment UI.

For backend debugging without interactive login, `npm run test:runtime` uses
real local workerd/SQLite with mocked upstream identity verification. The
separate GitHub organization OAuth connection still needs an interactive check.

The hosted page and demo import `ReownAuthentication` from the public
`@reown/appkit-controllers/features` export. Importing the broader
`@reown/appkit-siwx` barrel also loads Bitcoin verifiers whose Node dependencies
fail during Vite browser initialization; those unused packages are omitted.

AppKit 1.8.24's dependency audit currently reports 11 high package findings,
all tracing to the same Zod collection-validation memory exhaustion advisory
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
AppKit Wallet pins Zod 3.22.4; Coinbase SDK dependencies bring in Zod 3.25.76.
The new hosted page uses the same AppKit version, so review its affected paths
and upstream fixes before rollout. No incompatible major-version overrides or
forced SDK downgrades are applied. Recheck with `npm --prefix web audit` and
`npm --prefix demo audit` as advisories and upstream releases change.

### Hosted page component mapping

| Hosted element / state             | APP equivalent                                       | Implementation                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Monoid mark                        | `src/@assets/monoid.svg`, card logo treatment        | Original white mark, primary background, approved 56px square and 14px radius.                                                     |
| Sign in to Monoid                  | `ViewHeaderTitle`                                    | Shared heading leaf in the approved centered browser identity block; 24px/32px, no corner header.                                  |
| Authority host                     | `IconTag`, `IconTagName`, `WhiteTag`, `AppIcon`      | Existing bordered icon/name tag, with `Lock`. Text is the actual `location.host`, so development and custom hosts remain truthful. |
| Purpose / return line              | `InfoSectionItemLabel`                               | Shared secondary text color, 14px/21px, centered.                                                                                  |
| Account card                       | Card Applets row + `InfoFieldset` / `InfoLegend`     | Exact app integration markup above, 36px Symbol and shared list name/description.                                                  |
| Use another account                | `IconButton` + `AppIcon(ArrowLeftRight)`             | Trailing row action, disabled while busy, accessible name; no third footer button.                                                 |
| Preparing                          | `StandaloneLoadingSpinner` (shared `LoadingSpinner`) | Centered under identity, with a status label.                                                                                      |
| No flow / busy notice / cancelled  | `InfoMessage`                                        | Existing notice component. Cancellation remains quiet with one neutral back button.                                                |
| Error                              | `WarningMessage`                                     | Existing warning component and actionable sanitized copy. The shared component supplies `role="status"`.                           |
| Approved                           | Local `OperationComplete` adapter                    | Existing success graphic/animation, optional `label="Signed in"`, secondary return line and neutral back button.                   |
| Sign in / Continue / Cancel / Back | Local APP `Button` adapter                           | Existing 40px text-only buttons, primary + neutral; 8px footer gap.                                                                |
| Theme / AppKit accent              | Shared `variables.css`                               | Primary color read from the app theme.                                                                                             |

The completion adapter retains the app's markup/animations and direct UI-leaf
imports; its only new option is `label` (default `Complete`). `Symbol` is a
small copy of the private Card Applets style. These have the same maintenance
boundary as the Button adapter; no APP services or source are changed.

The approved browser-specific composition has no in-app page equivalent: a
centered identity block explaining Monoid and this Authority's purpose, 48px top
inset, 16px identity gaps, 32px separation to content, and a centered column capped
at 400px with a 16px inset. Below 600px, actions stay at the viewport bottom.
At the single `min-width: 600px` breakpoint, the identity, content and actions
center vertically as one group. Actions follow the content by the app's
`--view-section-gap` (16px default); empty content/actions add no gap. The
identity-to-content gap stays 32px. The centered title keeps its 24px/32px size
and inherits `ViewHeaderTitle`'s app typography/weight instead of forcing 600.
AppKit's provider chooser, email/OTP, social
consent/signature screens and browser-to-APP callback/retry remain SDK/browser
behavior. Those are the only elements without direct APP component equivalents.

Rendering validation (2026-10-27): Chrome at **412×915** and **1440×1000**, served
from the web dev server with synthetic provider/API responses and a locally
routed production hostname. Screenshots cover no flow, preparing, signed out,
email, social with/without email, wallet, error, cancelled and approved, plus a
long email and absent email. Checks include the original logo, tag, 400px column,
shared row geometry, full-address accessible value, wrapping, button actions,
non-blocking callback cleanup, and no horizontal overflow. This does not claim
live OAuth, embedded-wallet sign-out or native callback acceptance.

The source uses the APP's `classNames` import spelling consistently. Mixing it
with `classnames` gave Vite 8's Windows dependency optimizer two conflicting
entry names (`classNames2.js`), preventing the dev server from starting.

### Automated checks

Requires Node 24 (tests use `node:sqlite`):

```sh
npm ci
npm --prefix web ci
npm run check
npm test
npm run test:runtime
npm --prefix web test
npm --prefix web run build
npm --prefix demo test
npm --prefix demo run build
```

For an authorized production deployment, build and publish without a key file:

```sh
npm run deploy
```

The first activation initializes the Durable Object key record. Verify
`/v1/metadata` and a challenge-bound time proof after deployment,
then restart/redeploy and check that the public key remains unchanged. Keep the
same namespace and object identity on later releases; never generate replacement
keys in a local provisioning script.

The runtime test bundles with `wrangler deploy --dry-run` and uses local workerd,
real SQLite Durable Objects and mocked provider responses. It makes no deployment
or external OAuth requests. Unit tests include independent HPKE decryption,
signature binding, PKCE/state/cookie/replay checks, live permission changes,
policy immutability and owner isolation. Physical Java Card acceptance,
complete production Reown login and GitHub organization OAuth remain rollout checks.

The hosted page's rendering checks are described below. They use synthetic
provider/API responses for deterministic states and do not establish a live
Reown sign-in or physical iOS/Android callback acceptance.

The earlier local demo has also been checked in Chrome: AppKit opens its wallet chooser,
the time proof passes WebCrypto verification with the matching random challenge,
and desktop/mobile layouts render without horizontal overflow. A user completed
real GitHub social login on 2026-10-24; the Worker validated the resulting Reown
credential, issued an Authority session and returned Reown and wallet namespaces.

The backend separates domain types, name validation, provider requests,
Reown/Authority sessions, hosted authorization-code login and browser GitHub
OAuth. Hosted-page tests cover its browser authentication lifecycle.
Demo tests cover logout and identity-switch races, including late provider
events and late exchanges. The earlier successful desktop demo login does not
establish acceptance of the new system-browser flow on physical devices.

Before enabling client enrollment, verify actual Reown login/profile stability,
mobile callbacks, card enrollment, and Cloudflare CPU usage under expected load.
The initial production time request succeeded; local tests do not prove that all cryptographic requests fit
the account's Free CPU limit. Account quotas are shared with gas-history; measure
request/CPU/DO SQL usage and set a traffic expectation before expanding access.
The per-IP/per-account rate limiter is approximate and location scoped; it is
not a global spending cap. There is no automatic plan upgrade. Observability
logs are disabled to avoid capturing OAuth URL parameters.
