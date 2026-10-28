# Monoid Authority

Cloudflare Worker providing Authority bundle enrollment and challenge-bound time
proofs. Google and GitHub identities are verified directly by the Worker.
Wallets prove control with SIWE. Reown AppKit is only the replaceable
wallet-connection UI, not an identity provider or owner namespace.

The app opens the hosted `/login` page in the system browser app, using PKCE and
`app.monoid://authority/callback`. The app calls Authority groups **bundles**;
wire names `groupName`, `groups` and `/v1/groups/list` remain unchanged.

## Public pages and Google branding

The Worker serves public, static HTML at `/` (home), `/privacy` and `/terms`.
The home page explains the optional service and links to the policies without
sign-in; it no longer redirects to `/login`. These pages need no JavaScript,
cookies, provider SDK or external assets. They use the login page's shared
`web/src/style.css`, Ionic typography and app colour tokens. The public pages
add Ionic's system dark palette; `/login` retains its existing light appearance
and flow, with small Privacy / Terms links in every state. Policy links respect
the development base path and do not carry flow parameters. Operator: Monoid;
privacy/deletion contact: `support@monoid.app`; effective date: 28 October 2026.

After deploying these pages, use these Google Auth Platform **Branding** fields:

| Field                        | Value                                  |
| ---------------------------- | -------------------------------------- |
| Application home page        | `https://authority.monoid.app/`        |
| Application privacy policy   | `https://authority.monoid.app/privacy` |
| Application terms of service | `https://authority.monoid.app/terms`   |
| Authorized domain            | `monoid.app`                           |

Google requires ownership verification of the authorized domain. Publishing
the pages does not itself publish or verify the OAuth consent screen; that is
a separate console action. See [Google's brand-verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).
The existing OAuth callback URI and scopes below are unchanged.

### Policy facts checked against the implementation

- `storage.ts` writes `namespace_names` only for an explicit label change.
  Google `sub` and the default display name live in encrypted authentication
  records; signing in alone creates no persistent profile. Owner IDs persist
  with created bundles or explicit labels. A verified email is the default
  display name, not a separate saved email field.
- GitHub tokens are encrypted in a flow, handoff grant and bearer session, not
  just the final session row. They are usable only within that flow/session's
  limits; expired copies can remain until cleanup. Membership lists are not
  persisted. Organization and wallet records are visible to other authorized
  controllers, and account/bundle information is returned to the user's app.
- Wallet challenges contain an address when already known and an unsigned SIWE
  message (or message fields for WalletConnect). Submitted signatures are not
  persisted. RPC verification sends the address, message hash, signature and
  verification data as required; EOA verification is local.
- `api.ts` / `crypto.ts` do not store recipient card public keys, time-proof
  challenges, card private keys, OTP secrets or individual bundle roots. A
  persistent service master derives roots from owner, name and policy.
- Requests/flows last 10 minutes from start; OAuth attempts share the flow
  deadline; wallet challenges last at most 5 minutes within that flow; the SIWE
  proof expires after 15 minutes; app handoff codes last at most 60 seconds.
  Bearer authentication has the existing 5-minute idle / 15-minute absolute cap,
  reduced by provider/proof expiry. Consumption/logout removes applicable rows
  immediately; other expired rows are inaccessible and cleaned by hourly alarms,
  not necessarily erased at the instant of expiry. Provider browser sessions
  are separate and may persist.
- AES-GCM protects identities, GitHub tokens and OAuth attempt secrets. Lookup
  tokens/proofs are hashed, but owner IDs, labels, policies, routing metadata and
  wallet challenge contents are not all individually encrypted or hashed.
  [Cloudflare encrypts Durable Object storage at rest](https://developers.cloudflare.com/durable-objects/reference/data-security/).
- IP rate-limit keys apply to API requests; account keys additionally limit
  bundle issuance. Neither is written to the Worker's database. This does not
  assert that Cloudflare keeps no network/security information.
- Stored observability remains disabled. Redacted diagnostics are emitted for
  live tail, not saved by Worker code. Live platform metadata can contain URLs;
  no blanket claim is made about all provider/platform logging.
- Deletion is an operator-assisted request via email, not a public deletion API.
  It removes live labels/bundle records, not existing card contents or the
  ability to derive the same root with the unchanged master. Support email is
  separate from database/session retention. The policy makes no immediate
  erasure promise for hosting-platform recovery copies.

The Google policy includes the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
and Limited Use commitment. Policy updates change the effective date; a new use
of Google data also requires notice and any required consent. No governing-law
clause is included in the terms.

## Identity and bundles

Both `POST /auth/login/token` and `GET /v1/me` return exactly:

```ts
type Account = {
  source: 'google' | 'github-user' | 'wallet';
  id: string;
  displayName: string;
};
```

| Source                | Stable owner ID                            | Default display name                                                             |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `google`              | Google OIDC `sub`                          | Email when `email_verified === true`; otherwise name, otherwise `Google account` |
| `github-user`         | GitHub numeric user ID as a string         | GitHub login                                                                     |
| `wallet`              | `eip155:<lowercase address>`               | EIP-55 checksummed address                                                       |
| `github-organization` | GitHub numeric organization ID as a string | Organization login; namespace only, never the account                            |

The account is its personal owner namespace. There are no separate `method`,
`provider`, `email` or `login` fields. Display text never determines identity or
merges accounts. Former Reown project/profile owners are abandoned test data:
no compatibility route, alias, migration or authorization path exists. Their
stored policies are unreachable through this API. New owners get new roots.

`/v1/namespaces` returns the account namespace, plus organizations **only for
GitHub sign-in**. Active Owner membership (`state=active`, `role=admin`) is
required. The Worker rechecks the token's GitHub user ID and current memberships
on namespace listing and every organization bundle listing, issuance or label
change. Ordinary/pending membership, revoked tokens, changed identity, provider
errors and incomplete pagination fail closed. Personal operations use the
short-lived verified session without remote provider revalidation.

Namespaces are immutable `(source, id)` pairs. User-assigned labels override
namespace display names, not `account.displayName`, ownership or roots. Wallet
and organization labels are shared by their currently authorized controllers.
The bundle name is an optional second level: an owner alone is a valid bundle.
For example, `id@wsh.earth` and `id@wsh.earth / treasury` identify different
bundles. Omit `groupName` or send `groupName: ""` for the unnamed bundle; both
canonicalize to the empty string `""`. Issuance responses always include
`groupName: ""` for it, and bundle listings return `name: ""`.

Non-empty names keep the existing validation: case sensitive, NFC Unicode,
1–128 UTF-8 bytes, no outer whitespace, control or format characters. Null and
non-string values are invalid. Namespace display names remain required and
non-empty. First issuance fixes `allowPeerExtension` independently for each
owner/name, including the unnamed bundle; conflicting policy returns 409.
Root derivation stays:

```text
["Monoid Authority Bundle Root", 1, source, id, NFC(groupName), allowPeerExtension]
```

For the unnamed bundle the name element is exactly `""`, which cannot collide
with any valid non-empty name. Named roots and the derivation format do not
change; no storage migration is needed.

`/v1/groups/list` sorts the unnamed bundle first. Omit `after` to start at the
beginning; `after: ""` means strictly after the unnamed bundle, not the start.
A non-empty cursor resumes strictly after that NFC-normalized name. Explicit
null is not a request cursor. Responses contain at most 100 rows; pass a
non-null `next` verbatim as `after`, and stop only when `next === null` (not by
testing truthiness). A full final page may require one empty follow-up page.

## Hosted login and app integration

1. The app creates random state and a PKCE verifier, then POSTs
   `/auth/login/start {redirectUri, state, codeChallenge, codeChallengeMethod: "S256"}`.
   The challenge is base64url SHA-256 of the verifier. Callback allowlisting is
   exact. Retain state/verifier locally; the verifier never enters a browser URL.
2. Open the returned URL in the system browser app. The Worker consumes the
   request, sets a flow-specific HttpOnly, SameSite=Lax cookie (Secure and
   `__Host-` on HTTPS), and redirects to `/login`. Flow lifetime is ten minutes.
   The page scrubs the flow query before wallet resources load and retains it
   in tab-scoped sessionStorage for OAuth return/reload.
3. Google and GitHub use **same-tab authorization-code redirects**, not popups.
   Every attempt has separate state and S256 PKCE bound to the flow/cookie;
   Google also has a nonce. The Worker verifies identity, binds it encrypted to
   the flow, and returns to `/login` with the account and Continue/Cancel.
4. Continue sends **only** `/auth/login/complete {flow}`; extra fields/client
   identity claims are rejected. Atomic completion returns a callback with a
   one-use code and app state. Cancel consumes the flow and returns
   `error=access_denied` with state. Reset/new attempts invalidate older proofs;
   late callbacks/signatures cannot restore a reset or cancelled identity.
5. The app checks exact callback/state and exchanges
   `/auth/login/token {code, codeVerifier, redirectUri}` within 60 seconds.
   Atomic redemption checks both PKCE and callback. Response is
   `{accessToken, tokenType: "Bearer", expiresIn, account}`. Provider tokens
   never reach the app, page JavaScript or app callback.
6. Keep the bearer in memory. Each successful bearer authentication renews a
   **five-minute idle window**, within a fixed **15-minute absolute cap** from
   identity verification or provider/proof expiry, whichever is earlier.
   `expiresIn` reports the initial remaining idle window (at most 300 seconds).
   Public calls/failed authentication do not renew it; expired sessions return 401. Atomic touches never revive expired/deleted rows. The app clears its
   bearer and calls `/auth/logout` on completion, leaving, hiding and five idle
   minutes.

Continue/Cancel await the Worker's redirect URL, discard in-memory wallet SIWX
credentials, start AppKit disconnect **without awaiting it**, save the fallback
state and call `location.assign(url)`. Late identity results are ignored.
No provider/identity credentials are stored in localStorage; automatic wallet
reconnect is disabled. Google/GitHub browser cookies can persist: only the
Authority session is short-lived, not the provider's browser login.

External-scheme navigation after network work may lack recent user activation.
Both fallbacks offer a neutral **Back to Monoid** button whose click handler
directly calls `location.assign(returned.url)`. Cancel attempts automatic return,
then shows only `InfoMessage("Sign-in cancelled.")` if the browser stays; there
is no success graphic. Approval uses the completion adapter with `Signed in`
and `Return to Monoid to continue.`. Native launch/callback handling belongs to
the app; no device acceptance is implied.

### Provider verification

**Google:** authorize at `https://accounts.google.com/o/oauth2/v2/auth` with
`openid email profile`, `prompt=select_account`, state, nonce and S256 PKCE.
Exchange at `https://oauth2.googleapis.com/token` with the Worker secret.
`jose` verifies **RS256 against Google's JWKS** at
`https://www.googleapis.com/oauth2/v3/certs`, plus issuer exactly
`https://accounts.google.com`, audience, expiry, issued-at, nonce and subject.
Multi-audience tokens require the correct authorized party; any supplied `azp`
must match. We do **not** use OIDC's token-endpoint TLS signature exemption.
Only verified email is displayed as email; the access token is not retained.

**GitHub:** authorize at `https://github.com/login/oauth/authorize` with
`read:org`, state and S256 PKCE. Exchange with secret/verifier, require a bearer
token with that scope, and read GitHub `/user`. The encrypted token remains
only for the flow/session lifetime to check organizations. The separate
Connect GitHub approval page and session-linking/rotation protocol are removed.

**Wallet:** AppKit's public `SIWXConfig` obtains a Worker nonce bound to the
flow, browser and attempt. SIWE (EIP-4361) binds Authority host, full
`AUTHORITY_URL`, chain 1, nonce, issue time and a 15-minute proof expiry.
The nonce lasts at most five minutes or flow expiry. Injected wallets receive
the complete message for their address. WalletConnect requests metadata before
knowing the address; its final signed message supplies the address and must
preserve server fields. Signed recap text grants no Authority capabilities.
`viem` verifies EIP-191 EOAs locally and ERC-1271/ERC-6492 through its universal
verifier on `ETHEREUM_RPC_URL`. The RPC must report Ethereum mainnet; failures
fail closed. Contract-wallet verification is mainnet only.

Default RPC: **Allnodes PublicNode**, `https://ethereum-rpc.publicnode.com`.
It is non-Reown and configurable. RPC contract state is a trust dependency;
WalletConnect project/relay settings do not verify identity.

Installed AppKit **1.8.24** source checked:

- `@reown/appkit-controllers/dist/types/src/utils/SIWXUtil.d.ts`: public SIWX
  interface (`createMessage/addSession/getSessions/setSessions/revokeSession`,
  `getRequired`, `signOutOnDisconnect`).
- Its `dist/esm/src/utils/SIWXUtil.js`: WalletConnect requests an empty-address
  challenge before `authenticate`, then supplies signed sessions; injected
  signing uses the complete message.
- `@reown/appkit/dist/esm/src/client/appkit-base-client.js`: public `ready`,
  `updateRemoteFeatures`, `updateOptions`, `disconnect`, `enableReconnect`.
  Dashboard settings can replace local features/SIWX during startup. Before
  opening, the adapter disables email/socials/email capture/Reown authentication
  and restores its custom SIWX through the public options API.

Injected-provider and WalletConnect deep-link/QR connectivity remain. Project
ID is connectivity configuration only, absent from owners/roots. No identity
verification calls Reown. Email sign-in and old provider-token/social metadata
paths are removed. No Telegram redirect or private SDK internals are used.

References: [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect),
[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[AppKit SIWX](https://docs.reown.com/appkit/react/core/siwx),
[PublicNode](https://ethereum.publicnode.com).

### Shared account markup

Copy `SOURCE_NAMES`, `AccountRow`, `Symbol` and `AccountCard` from
[account.tsx](web/src/account.tsx) verbatim, changing only imports/type location.
They follow `src/@components/views/card/card-management-content.tsx`: private
Symbol style copied exactly (36×36px, 9px radius, primary background, white 28px
icon), shared list leaves and fieldset. Row gap is 12px; content gap 2px; name
line-height 20px; row padding zero. Names use `min-width: 0`,
`overflow-wrap: anywhere`, `text-wrap: pretty`; Address uses `width: 100%`.
Long names wrap; wallet addresses use middle ellipsis with their full checksum
value in title/aria-label.

| Source      | Existing lucide icon | Name                         | Description |
| ----------- | -------------------- | ---------------------------- | ----------- |
| google      | UserRound            | account.displayName          | Google      |
| github-user | UserRound            | account.displayName          | GitHub      |
| wallet      | Wallet               | Address(account.displayName) | Wallet      |

All icons already exist in the app/installed lucide version; no brand icons
are invented. Exact markup:

```tsx
<InfoFieldset>
  <InfoLegend>Signed in as</InfoLegend>
  <AccountRow>
    <Symbol>
      <AppIcon icon={icon} aria-hidden="true" />
    </Symbol>
    <ListItemContent>
      <ListItemName>
        {account.source === 'wallet' ? (
          <Address title={account.displayName} aria-label={account.displayName}>
            {account.displayName}
          </Address>
        ) : (
          account.displayName
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

Use another account clears the verified flow, disconnects any wallet and returns
to choices. Actions retain the Card actions popup's full-width stack and 8px
gap (`src/@components/views/safe/@card/card-view.tsx`). The hosted signed-out
choices **Continue with Google**, **Continue with GitHub**, **Connect wallet**
and **Cancel** are all neutral white buttons, with no primary choice.

The page's Button adapter adds an optional decorative `icon: ReactNode` slot:
a fixed 20×20px inline-flex span (`aria-hidden="true"`) before the label, using
the shared Button's existing center alignment and 8px content gap. SVG/image
children fit that square without stretching their aspect ratio. The icon and
label center as one group; loading keeps them together. This is the only icon
extension to the app Button, which has no dedicated icon prop or icon-bearing
usage. Connect wallet and Cancel remain text-only: they have no provider mark,
and their labels use the same centering, height and typography.

Provider SVGs are bundled locally in `web/src/assets/`:

- `google-g.svg`: the unmodified multicolour G paths/colors from the HTML button
  configurator linked by [Google's sign-in branding guidelines](https://developers.google.com/identity/branding-guidelines).
  It renders as a 20px image on the neutral white button, outside the app's
  monochrome `AppIcon` color rule.
- `github-invertocat.svg`: `GitHub Logos/SVG/GitHub_Invertocat_Black.svg` from
  [GitHub's official logo archive](https://brand.github.com/GitHub_Logos.zip),
  linked by its [brand toolkit](https://brand.github.com/foundations/logo).
  Only its outer canvas size is set to 24×24 for the shared `AppIcon`; the
  original viewBox and artwork remain intact. `AppIcon` renders its fill with
  the button's `currentColor`.

The account row continues to use `UserRound` for Google/GitHub.

Other components stay mapped to the app: original SVG on 56px primary square;
regular ViewHeaderTitle; outlined authority host tag; secondary
InfoSectionItemLabel; InfoMessage, WarningMessage and StandaloneLoadingSpinner.
The host is one ordinary outlined capsule, matching `KeyDerivationTag` in
`src/@components/@key/key-tags.tsx`. It reuses `Tag` and `leadingIconTagCSS`
directly: 22px height, 13px text, 12px radius, 0.5px border, 2px icon/text gap,
3px left padding and 6px right padding. Because the app component hardcodes
`AddressChainIcon` and keeps its container/text styles private, the page mirrors
those colour and ellipsis rules exactly while using Lucide `Certificate`.
The icon copies `AddressChainIcon`'s 14×14px, non-shrinking block layout and
inherits the capsule's text colour. The same `--color-address-tag-*` overrides
and fallback tokens apply; there is no filled segment, overlap or inner seam.
Button/completion adapters retain app markup with the icon slot above;
completion adds an optional label.
The approved browser identity composition has no in-app screen equivalent.
Column max width is 400px; inset/identity gaps 16px; content gap 32px. Mobile
footer stays at bottom. At min-width 600px the whole group centers vertically,
with the app's 16px gap before actions. Wallet chooser/signature screens and
browser/app handoff are SDK/browser behavior.

## HTTP API

Production base: `https://authority.monoid.app`; local base:
`http://localhost:8787/api/authority`. Binary values use unpadded base64url except
Ethereum signatures (0x hex) and SIWE text. Bodies are limited to 4096 bytes,
or 65536 for signature verification. Responses are no-store; errors are
sanitized `{error: string}` with 400/401/403/409/413/429/502/503 or unknown 500.

| Method/path                                        | Authentication                     | Input / result                                                                                                                |
| -------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET /v1/metadata                                   | Public                             | Authority key and algorithms                                                                                                  |
| POST /v1/time                                      | Public, rate limited               | {challenge} → {publicKey, data, signature}                                                                                    |
| POST /auth/login/start                             | Public, rate limited               | App PKCE/state/callback → {authorizationUrl, expiresIn}                                                                       |
| GET /auth/login                                    | One-use request                    | Cookie and redirect to /login                                                                                                 |
| GET /login                                         | Public assets                      | Identity operations require a valid flow                                                                                      |
| GET /auth/login/context?flow=...                   | Flow cookie                        | {projectId, expiresAt, account, error?, providers: {google, github, wallet}}; account null until verified                     |
| POST /auth/login/google or /auth/login/github      | Cookie + same Origin               | {flow} → {authorizationUrl}                                                                                                   |
| GET /auth/google/callback or /auth/github/callback | State + cookie                     | Verify/bind and return to /login; provider errors return sanitized error                                                      |
| POST /auth/login/wallet/nonce                      | Cookie + same Origin               | {flow, address, chainId: "eip155:1"} → {data, message?}; empty address supports WalletConnect                                 |
| POST /auth/login/wallet/verify                     | Cookie + same Origin               | {flow, message, signature} → {account}                                                                                        |
| POST /auth/login/reset                             | Cookie + same Origin               | {flow} → {account: null}                                                                                                      |
| POST /auth/login/complete                          | Cookie + same Origin               | Exactly {flow} → {redirectUrl} with code/state                                                                                |
| POST /auth/login/cancel                            | Cookie + same Origin               | {flow} → {redirectUrl} with cancellation/state                                                                                |
| POST /auth/login/token                             | Code + app PKCE + callback         | {code, codeVerifier, redirectUri} → {accessToken, tokenType, expiresIn, account}                                              |
| POST /auth/logout                                  | Bearer syntax                      | 204; removes session, including already expired/revoked                                                                       |
| GET /v1/me                                         | Bearer                             | {account}                                                                                                                     |
| GET /v1/namespaces                                 | Bearer; live org checks for GitHub | {namespaces: [{source, id, displayName}]}                                                                                     |
| GET /v1/organizations                              | GitHub bearer; live checks         | {organizations: [{source, id, displayName}]}                                                                                  |
| POST /v1/namespaces/name                           | Bearer + owner permission          | {owner, displayName} → {namespace}                                                                                            |
| POST /v1/groups/list                               | Bearer + owner permission          | {owner, after?} → {owner, groups, next}, at most 100 rows                                                                     |
| POST /v1/bundle                                    | Bearer + owner permission          | {owner, groupName?, allowPeerExtension, recipientPublicKey} → {publicKey, data, bundle, owner, groupName, allowPeerExtension} |

## Cryptography and storage

One P-256 key serves HPKE Auth and ECDSA time signing. An independent 32-byte
master derives roots with HMAC-SHA256 over UTF-8 JSON serialization of the array
above. HPKE uses RFC 9180 Auth, DHKEM(P256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM,
empty AAD and fresh encapsulation. An independent receiver tests the 182-byte
packet. See sibling Java Card [authority.md](../../../monoid-javacard/doc/authority.md).

```text
data = 01 || unixSeconds_u64_bigEndian || challenge[32]  // 41 bytes
signature = ECDSA-P256-SHA256("Monoid Authority Time" || data)
```

Time signatures are 64-byte P1363 r||s, not DER. Pin the Authority key, retain a
fresh challenge, reject reuse and impose a freshness/delay policy. Metadata
describes service protocol, not firmware capabilities. Online revocation does
not revoke offline bundles. Authority knows roots; authorized owners may request
any valid P-256 recipient, with no card attestation. Card enrollment must verify
Authority trust and the Join Bundle result; never replay an uncertain operation.

The Durable Object generates and atomically stores P-256/master keys inside
workerd, reusing them on restart/deploy. No key rotation/import/export/storage
reset is part of this change. Stored private JWK/master bytes become
non-extractable WebCrypto keys in memory; this is software isolation, not an HSM.
Preserve namespace, object name `authority` and key record. No local key
provisioning or backup/export workflow exists.

SQLite retains policies/labels. Provider tokens and verified identities are
AES-GCM encrypted under a domain-separated master-derived key. Random
bearer/code/state keys are hashed. Flow compare/replace and code consumption are
atomic SQL. Expired records are immediately inaccessible and physically cleaned
by hourly alarms while records remain. Storage restore rewinds codes/revocations
and requires explicit recovery verification/session invalidation.

## Configuration and OAuth apps

Wrangler contains public vars only. Fill empty OAuth client IDs; provision
secrets through Cloudflare secret input/dashboard, never committed files or
command-line values. Missing configuration disables its choice and returns 503.

| Setting                  | Kind           | Purpose                                                     |
| ------------------------ | -------------- | ----------------------------------------------------------- |
| AUTHORITY_URL            | Var            | Canonical base, no trailing slash                           |
| GOOGLE_CLIENT_ID         | Var, empty     | Google Web application OAuth client                         |
| GOOGLE_CLIENT_SECRET     | Secret         | Google code exchange                                        |
| GITHUB_CLIENT_ID         | Var, empty     | GitHub OAuth App client                                     |
| GITHUB_CLIENT_SECRET     | Secret         | GitHub code exchange                                        |
| ETHEREUM_RPC_URL         | Var            | Ethereum mainnet RPC, defaults to PublicNode                |
| WALLETCONNECT_PROJECT_ID | Var            | Connectivity only; existing public project retained         |
| APP_REDIRECT_URIS        | JSON-array var | Exact callbacks, no wildcards                               |
| APP_ORIGINS              | JSON-array var | API CORS; ["*"] does not permit cross-origin flow mutations |

Google **Web application** OAuth client: register
`https://authority.monoid.app/auth/google/callback`, configure consent/test users
and scopes `openid email profile`. No browser Google SDK or popup is needed.
GitHub **OAuth App**: homepage `https://authority.monoid.app`, callback
`https://authority.monoid.app/auth/github/callback`, scope `read:org`.
Organization OAuth restrictions/SSO may require approval; inaccessible
memberships fail closed. Use separate development clients/apps for local URLs.

Allow the hosted origin in WalletConnect project settings. Disable dashboard
email/social/email-capture/Reown-authentication features; the page also enforces
wallet-only configuration. Changing project does not change owner IDs. The app's
separate WalletKit project is unchanged. Never configure Authority private keys
or the bundle master as vars/secrets.

### Local development

Requires Node 24 (tests use node:sqlite):

```sh
npm ci
npm --prefix web ci
npm run dev:init
npm run dev
```

dev:init creates ignored .dev.vars only if absent and supplies no credentials.
Existing files are preserved; update names above manually. Supply development
OAuth values through your usual secret-management workflow. Register exactly:

- Google: `http://localhost:8787/api/authority/auth/google/callback`
- GitHub: `http://localhost:8787/api/authority/auth/github/callback`

Keep AUTHORITY_URL at `http://localhost:8787/api/authority`, opening the flow on
that same host. Another hostname/port or a Vite-origin cookie does not match.
dev builds/serves through local Wrangler; use `npm run dev:web` in a second
terminal for rebuilds. Custom HTTPS development needs matching callbacks,
canonical base, app allowlist and WalletConnect origin. Tests need no real
credentials.

The **demo was removed**: it duplicated the old token exchange/GitHub linking
protocol. The hosted page plus protocol/workerd/browser tests now cover the
supported flow. There is no demo build/test target.

### Sign-in diagnostics

From `workers/authority`, run `npx wrangler tail` while reproducing a sign-in
failure to see the Worker's diagnostic `console.warn` lines. This uses
[Cloudflare real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/);
stored observability remains disabled in `wrangler.jsonc`.

Token exchange failures emit one `[oauth]` line containing only the provider,
HTTP status, and string `error` / `error_description` fields from the provider.
JSON and form-encoded error bodies are accepted up to 16 KiB; unreadable,
oversized or malformed bodies still produce the provider/status line. Fields
are capped at 128 and 512 characters respectively, control/line-separator
characters are flattened, and known request credentials and returned tokens
are redacted if echoed in those fields. GitHub OAuth errors returned with HTTP
200 are diagnosed too. Codes, verifiers, client secrets, tokens, raw bodies and
exception objects are never passed to the logger.

Google ID-token rejection emits one `[oidc]` line containing the provider and
only a fixed `check`: `signature`, `issuer`, `audience` (including authorized
party), `expiry`, `nonce`, or `claims`. No token or claim values are logged.
Public error codes and the hosted page's messages stay unchanged. For example:

```text
[oauth] {"provider":"google","status":400,"error":"invalid_grant","error_description":"Bad Request"}
[oidc] {"provider":"google","check":"nonce"}
```

Tail output also includes Cloudflare request metadata, which can contain OAuth
callback query parameters; share only these sanitized diagnostic lines.

### Checks

```sh
npm run check
npm test
npm run test:runtime
npm --prefix web test
npm --prefix web run build
```

Runtime tests include web typecheck/build, Worker build, Wrangler **dry-run**
bundle and real workerd/SQLite. No deployment occurs. Google/GitHub/RPC endpoints
are mocked. Coverage includes JWT signatures, state/nonce/PKCE, audience/issuer/
expiry, unverified email, org permissions, EOA/contract signatures, SIWE fields,
replay, account-switch races, session caps, persistence, HPKE and time proofs.
Contract RPC mocks verify integration, not live contract-wallet acceptance.

Screenshots use the actual page with synthetic account/context responses at
412×915 and 1440×1000: choices, Google, GitHub, wallet, cancelled, approved.
Checks include row geometry, long values, full-address accessibility, mobile
footer, centered desktop group and overflow. Real OAuth callbacks, wallet deep
links and native handoff require live acceptance after configuration. No phone
or real OAuth credentials are used here.

AppKit's large dependency bundle produces build warnings. The app's classNames
import spelling avoids duplicate Windows Vite optimizer entries. Rate limits
are approximate/location-scoped (30 requests/minute per key), not a global
spending cap. Stored observability remains disabled to avoid retaining OAuth URL
parameters; the diagnostics above are available through live tail. Device/card
acceptance and runtime quota measurements remain rollout checks.
