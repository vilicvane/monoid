# Authority client

`entrances.authorityService` owns the hosted Authority connection. Its base is
`VITE_AUTHORITY_URL`, falling back to `https://authority.monoid.app/`. Setup cards
uses the client to choose a bundle and issue enrollment packets for each card.

| API                                                                       | Result                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `metadata()`                                                              | Public key as bytes, Bundle algorithm and time protocol                                                               |
| `signIn()`                                                                | Promise of `{id, login, method, email?, provider?}`; each call starts a fresh login and replaces the previous attempt |
| `pendingSignIn`                                                           | The current pending login's promise, including a restored attempt                                                     |
| `signInState`                                                             | Observable `idle`, `pending`, `complete`, or `error` with an `AuthorityError`                                         |
| `account`, `signedIn`                                                     | Observable in-memory session state                                                                                    |
| `cancelSignIn()`                                                          | Removes the pending login and rejects it as cancelled; late callbacks are ignored                                     |
| `signOut()`                                                               | Clears locally immediately and attempts logout without awaiting the network; failures are silent                      |
| `namespaces()`                                                            | Authorized `{source, id, displayName}` entries                                                                        |
| `groups(owner)`                                                           | All `{name, allowPeerExtension, createdAt}` pages for `{source, id}`                                                  |
| `issueBundle({owner, groupName, allowPeerExtension, recipientPublicKey})` | `{publicKey, data, bundle, owner, groupName, allowPeerExtension}` with byte fields decoded                            |

Sign-in opens the hosted page in the system browser app through
`@capacitor/app-launcher`. Android uses a plain `ACTION_VIEW` intent; iOS uses
`UIApplication.open`, both handing the HTTPS URL to the default browser
(Chrome/Safari when configured as default). Browser Reown/provider sessions may
remain signed in; Monoid's bearer lifetime below is independent.

State and the PKCE verifier use `crypto.getRandomValues`. S256 uses the existing
SHA-256 implementation, so HTTP development WebViews do not need `randomUUID`
or `crypto.subtle`. Before opening the page, the app persists only the Authority
URL, state, verifier and ten-minute expiry under `authorityLogin`. Both platforms
accept the exact `app.monoid://authority/callback` link through `appUrlOpen` or
`getLaunchUrl`. A cold start restores the pending login only to accept its
matching callback. A synchronous claim prevents double redemption; the saved
attempt is removed before code exchange.

The Sign in button loads only while starting, saving and opening the browser,
then returns to idle without waiting visibly. Restored attempts also start idle.
Every new tap replaces the pending login; old or unrelated callbacks are ignored.
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
ended session or sign out a newer one. A mid-flow end returns to Choose bundle
signed out while retaining the chosen bundle and cards. An installation detour
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
after adding a card; Authority locks it after the first join. Authority uses two
steps: Choose bundle and Add cards. Sign-in lives inside Choose bundle, whose
footer is Sign in when signed out and Continue when signed in. The completed
step shows the bundle name as its summary. Choose bundle uses an owner selector when there
are multiple eligible namespaces (Account, Wallet, GitHub; organizations are
excluded for now). Its name input starts with the owner's most recent bundle,
and a trailing action opens a picker that fills the input without advancing.
Existing names lock their policy; new names allow choosing the policy and show
the permanence notice. Names are normalized to NFC in the input and must contain
1–128 UTF-8 bytes, without surrounding whitespace or control/format characters.
Continue selects the bundle or draft; no bundle is created until its first
issuance. Add cards uses the shared Setup grid: one pending card is ringed,
later cards say "join later", and joined cards are dimmed. Change bundle is
available until the first join. Done pops the steps and grid out before showing
the shared completion and Back to Card or Back to Safe.

Each Join authenticates the card's Secret PIN before requesting an Authority
packet, then checks the acknowledged bundle hash. The issued hash stays in the
flow: a later explicit scan can recognize a successful join after a lost response
without replaying Join. Cards must trust the same normalized Authority URL; Join
6985 names a mismatched Authority key. A 401 returns to Sign in and keeps the cards
and selected bundle. Installation and PIN setup use the existing Card Applets
detour, retaining flow state in CardBundleStore and reusing only the just-verified,
expiring in-memory Secret PIN. A foreign bundle still requires the shared reset
confirmation; Join never replaces it.

When a scanned card already has a bundle and this flow has not learned the
selected bundle's hash, it requests issuance for that card's key first. This
does not write to the card. A matching hash recognizes an existing member without
Join or reset; only a different hash can offer the shared reset confirmation.

The read-only `AuthorityAccountInfo` fieldset is labeled **Signed in as** and uses
the shared 36px `Symbol` and list content, like Card Applets. Email uses the Mail
icon, the email and **Email**; social uses UserRound, the email (or **GitHub
account**, for example) and the provider's display name. Wallet uses Wallet and
the shared `Address` for `login`, with **Wallet** beneath. Long email addresses
wrap within the row. Email/social never display the embedded wallet address.
If an email sign-in has no email, its name is **Signed in.**, matching the hosted
page; a social sign-in without provider metadata uses **Social account**.
The signed-out notice still names the issuing Authority. There is no account
switch action; leaving the flow ends the session.
