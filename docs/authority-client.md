# Authority client

`entrances.authorityService` is a registry. Call
`forAuthority(normalizeAuthorityUrl(hello.authority))` after reading a card that
trusts an authority. It returns an `AuthorityClient` for that URL, including its
base path; equivalent normalized URLs reuse the same client. There is no
build-time request target or fallback. Each client owns its bearer, account,
idle clock, pending PKCE login and observable sign-in state. Setup uses that
card's client to sign in, list bundles and issue enrollment packets.
Authority requests reject redirects, so a response cannot select another server.

The table below describes an `AuthorityClient`.

| API                                                                       | Result                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `metadata()`                                                              | Public key as bytes, Bundle algorithm and time protocol                                                  |
| `signIn()`                                                                | Promise of `{source, id, displayName}`; each call starts a fresh login and replaces the previous attempt |
| `pendingSignIn`                                                           | The current pending login's promise, including a restored attempt                                        |
| `signInState`                                                             | Observable `idle`, `pending`, `complete`, or `error` with an `AuthorityError`                            |
| `account`, `signedIn`                                                     | Observable in-memory session state                                                                       |
| `cancelSignIn()`                                                          | Removes the pending login and rejects it as cancelled; late callbacks are ignored                        |
| `signOut()`                                                               | Clears locally immediately and attempts logout without awaiting the network; failures are silent         |
| `namespaces()`                                                            | Authorized `{source, id, displayName}` entries                                                           |
| `groups(owner)`                                                           | All `{name, allowPeerExtension, createdAt}` pages for `{source, id}`                                     |
| `issueBundle({owner, groupName, allowPeerExtension, recipientPublicKey})` | `{publicKey, data, bundle, owner, groupName, allowPeerExtension}` with byte fields decoded               |

Accounts from token exchange and `/v1/me` are exactly
`{source, id, displayName}`. Identity and bundle ownership use the provider's own
stable `(source, id)`, never display text or a Reown profile. Reown is only a
replaceable wallet-connection UI; email sign-in is not supported.

| Source                | Stable owner ID                            | Account display name                                     |
| --------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `google`              | Google `sub`                               | Verified email, otherwise name, otherwise Google account |
| `github-user`         | GitHub numeric user ID as a string         | GitHub login                                             |
| `wallet`              | `eip155:<lowercase address>`               | EIP-55 address                                           |
| `github-organization` | GitHub numeric organization ID as a string | Namespace only; organization login                       |

An account's source is Google, GitHub user or Wallet. Owners also support GitHub
organizations. `/v1/namespaces` returns the account's own namespace and, for a
GitHub sign-in, organizations where the user is an Owner. Setup currently filters
organizations out of its owner controls. Namespace display labels affect only
presentation, not ownership or bundle roots.

Sign-in opens the hosted page in the system browser app through
`@capacitor/app-launcher`. Android uses a plain `ACTION_VIEW` intent; iOS uses
`UIApplication.open`, both handing the HTTPS URL to the default browser
(Chrome/Safari when configured as default). Browser provider sessions may
remain signed in; Monoid's bearer lifetime below is independent.

State and the PKCE verifier use `crypto.getRandomValues`. S256 uses the existing
SHA-256 implementation, so HTTP development WebViews do not need `randomUUID`
or `crypto.subtle`. Before opening the page, the app persists only the Authority
URL, state, verifier and ten-minute expiry under `authorityLogin`, as an array
with at most one pending attempt per normalized URL. Startup also reads the
previous single-attempt format so an already-open browser login can finish.
Writes are serialized across clients; cancelling or finishing one authority's
attempt preserves the others. Both platforms
accept the exact `app.monoid://authority/callback` link through `appUrlOpen` or
`getLaunchUrl`. A cold start restores each pending login to its saved authority
URL, independently of any card page currently open. Callback state selects that
login's client and token exchange goes only to its saved URL. A synchronous claim
prevents double redemption; the saved attempt is removed before code exchange.

The Sign in button loads only while starting, saving and opening the browser,
then returns to idle without waiting visibly. Restored attempts also start idle.
Every new tap replaces that authority's pending login; old or unrelated callbacks
are ignored.
A matching callback loads during code exchange and completes sign-in. Hosted
`error=access_denied` with the matching state cancels quietly. Cancellation and
expiry clear the saved attempt and return to idle. Closing the browser is not
observable by Monoid; the user can return and start a fresh attempt at any time.

Bearer and account remain in memory. The session uses the same
`HeldPINValue` lifetime as PINs: five idle minutes or app hiding, whichever comes
first. Authenticated Authority requests refresh idleness; public requests and
UI reads such as the account do not.
Timers wipe proactively, and wall-clock checks enforce expiry after suspension.
The shared app-hidden signal includes document visibility on all platforms and
Android Activity stop, without treating iOS inactive-only overlays as hidden.
The token response's `expiresIn` is validated (> 0 and at most 900 seconds), but
does not become a fixed client deadline: the Worker slides its five-minute idle
window on authenticated requests. The server enforces its fifteen-minute
absolute cap with a 401, which ends the local session through the same sign-out
path.

Done, leaving the Authority view, unmounting and a protected 401 also end the
session. Each end attempts `POST /auth/logout` with that bearer and clears locally
without waiting for the network; logout failures are silent, and repeated end
signals cannot log out the same session twice. A late response cannot restore an
ended session or sign out a newer one. These rules apply independently per
authority: ending one flow does not sign out another authority, and activity
against one server does not extend another's idle clock. App hiding clears all
held sessions. A mid-flow end returns to Sign in while retaining the chosen bundle
and cards. An installation detour
also signs out; its returned card stays in the flow until sign-in resumes.

Errors expose only stable codes: `unauthorized`,
`bundle_policy_conflict`, `rate_limited`, `network_error`, `service_error`,
`cancelled`, `expired`, and `invalid_callback`. No bearer, code, verifier or
provider response is logged or included in an error.

Card scans, retained flow snapshots and `CardStore` carry Hello's
`authority: string | false` alongside bundle/alias/extension policy. A later Hello
refreshes this cached value. It identifies the card's installed trust; metadata
does not change that trust, and no additional scan is made merely to display it.

Android registers VIEW/DEFAULT/BROWSABLE for the callback on its existing
singleTask MainActivity; iOS retains `app.monoid` in `CFBundleURLTypes`.
Capacitor sync generates the App Launcher dependencies for Android and iOS SPM.
Rebuild and reinstall both native apps after changing plugins. The normal iOS
workflow is `npm run ios:sync`; web build and `cap sync` can be run separately
to retain the existing bundled CAPs. Native binaries and a real hosted sign-in
still require device validation.

Setup cards offers None, Cards and Authority bundle modes at the top of the first
step's body; fixed card entry points omit these capsules. Cards locks the mode
after adding a card; Authority locks it after the first join. Authority uses
four derive-style steps: **Scan card**, **Sign in**, **Choose bundle**, **Add cards**.
The mode capsules live in Scan card. Its read supplies the trusted URL and keeps
that card as the first join candidate, without PIN input, reset or issuance.
A Card-page entry already supplies that candidate and satisfies Scan card.
Missing applets use the existing installation detour; the returned card then
supplies the authority. Sign in names the card's authority host and uses that
URL's session. Its completed summary shows the account. Choose bundle's footer
is Continue. The completed bundle step shows the owner text alone for an unnamed
bundle, or owner / name for a named bundle. The owner text is the namespace display
name or a middle-truncated wallet address, with end ellipsis for long paths.
Choose bundle uses an owner selector when there are multiple eligible namespaces,
labeled Google, GitHub or Wallet. Its name input starts with the owner's most
recent bundle, and a trailing action opens a picker that fills the input without
advancing.
The name is optional: an empty input selects the owner's unnamed bundle,
distinct from every named bundle and with its own fixed policy. The placeholder
is **Bundle name (optional)**. Issuance sends and returns `groupName: ""`; listings
represent it with `name: ""`. Its picker row displays the owner text and clears
the input when selected. If it is the most recent bundle, the prefilled input is
empty. Existing bundles, including the unnamed one, lock their policy; new
bundles allow choosing the policy and show the permanence notice. Policy
conflicts still return 409. Non-empty names are normalized to NFC in the input
and must contain 1–128 UTF-8 bytes, without surrounding whitespace or
control/format characters.
Continue selects the bundle or draft; no bundle is created until its first
issuance. Add cards uses the shared Setup grid: one pending card is ringed,
later cards say "join later", and joined cards are dimmed. Change bundle is
available until the first join. Done pops the steps and grid out before showing
the shared completion and Back to Card or Back to Safe.

Each Join authenticates the card's Secret PIN before requesting an Authority
packet, then checks the acknowledged bundle hash. The issued hash stays in the
flow: a later explicit scan can recognize a successful join after a lost response
without replaying Join. Further cards must trust the first card's normalized
authority URL. A different or absent authority is rejected before any PIN,
issuance or reset offer, including cards with unset PINs or existing bundles.
Cards without an authority retain the reinstall message. Join
6985 names a mismatched Authority key. A 401 returns to Sign in and keeps the cards
and selected bundle. Installation and PIN setup use the existing Card Applets
detour, retaining flow state in CardBundleStore and reusing only the just-verified,
expiring in-memory Secret PIN. A foreign bundle still requires the shared reset
confirmation; Join never replaces it.

When a scanned card already has a bundle and this flow has not learned the
selected bundle's hash, it requests issuance for that card's key first. This
does not write to the card. A matching hash recognizes an existing member without
Join or reset; only a different hash can offer the shared reset confirmation.

The read-only `AuthorityAccountInfo` fieldset is labeled **Signed in as** and
matches the hosted account row's shared markup and spacing. Google and GitHub use
UserRound, `displayName` and their source name; Wallet uses Wallet and the shared
`Address` with middle ellipsis. The shared `Symbol` remains 36px. Long names wrap
inside the row. The signed-out notice still names the issuing Authority. There
is no account switch action in the app; leaving the flow ends its session.
