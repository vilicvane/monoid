# OTP

Home → One-time Password opens OTP's cached account list, without card identities or card grouping.
Scans merge accounts by index; backups of the same account update its entry
instead of duplicating it, and accounts absent from a scan remain cached.
Tap an account to open its independent page and start NFC once the route is active.
An enabled card containing it returns the current and two following codes.
The header contains the account name and the provider in the shared white tag.
Tapping the account name or provider tag edits the full `provider: name` label, with that part
preselected: the same name
rules as import apply, the tapped card's item alias is updated first, and only an
acknowledged write updates the cached entry. A missing index reports a wrong card.
The deep-gray code is the primary content; tapping its digits copies it without a separate
copy icon, and the shared copy feedback changes its color briefly. Each loaded
window, including the current one, has a small countdown ring. The active ring
depletes clockwise and uses the shared warning text color at ten seconds remaining.
Later rings and their numbers share the same pale gray. Countdown numbers use the
normal UI font with proportional digits. Used windows shrink and fade over 200 ms;
the final code group exits together before the placeholder fades in. Exit clones
are inert and hidden from accessibility. Page exit/background clears codes immediately.
No placeholder
digits or rings appear without codes; use the shared ViewPlaceholder with a short
scan prompt instead. Scan again is always visible: neutral with
a current code, primary without one, and disabled during scanning. A retry retains
the current batch until replacement succeeds or the codes expire.
Returning from a cancelled scan does not automatically scan again. Only the account
index enters route state; codes remain page-local. Copying a code rechecks its
validity at the moment of the click and does not start another scan. The shared scanner uses that
card's saved Access PIN; an unknown PIN
uses its normal input-and-rescan flow. Explicit management of a known card can
request a missing PIN before scanning. Secrets stay in Monoid; cached lists never
contain secrets, PINs or codes.

The list title is One-time Password, matching Home and its menu. Each row starts
with a SHA-1, SHA-256 or SHA-512 capsule in pale blue, green or yellow. These
reuse Seed's light classification style: a pale background, matching border and
dark text; green uses the Seed palette directly. Then comes the same white
provider capsule as the account header. The second
line shows the account name; digit and period settings remain hidden. Clickable
rows reuse the shared ripple feedback, including collapsed provider groups. Split the
label at its first colon, retaining any later colons in the account name. Rows
with the same provider reuse Safe's expandable address groups, count badge and
row spacing: a sole group expands by default; otherwise a collapsed group opens
before an account can be tapped, and tapping a provider tag collapses it again.
Labels without a provider retain their full name and an OTP tag, and stay
independent. Collapsed groups do not expose an individual account's swipe actions.

Forget (yellow broom) removes only the local entry. Delete from card (red
credit-card-minus) removes it from the tapped card and retains the cache for other backups; the
prompt then asks for the next card until dismissed. Installation/authorization status
belongs only to the current page's scanned card, not to cached accounts. Enable
OTP on card remains a separate menu action and is never performed by code retrieval.

Incompatible account records are skipped individually, including invalid
configuration and items not marked secret. Valid accounts remain available. Transport,
authentication and cancellation failures still stop the scan; skipped records
are not deleted from the card.

The main Scan page accepts OTP QR codes and OTP links from Clipboard alongside
WalletConnect. After its camera cleanup and completion animation, it opens OTP's
account confirmation. OTP has no separate QR button or scanner. Scan a card loads
and merges existing accounts; there is no separate Refresh accounts action or
Card Applets shortcut. Enter manually and Enable OTP on card remain in the menu.
The QR URI passes through a one-use in-memory handoff: only its random ID enters
route state, and the draft clears when consumed or navigation finishes. Revisiting
a route never reopens a previously imported secret.
The Scan header alternates WalletConnect and One-time Password through the shared
TypewriterText input/delete animation, retaining its reduced-motion fallback.

Account management reuses the shared popup, QR scanner and swipe menu. Scanning an
`otpauth://totp/` QR code opens account confirmation; Add to card then starts NFC.
Manual entry accepts Base32 secrets. Neither path requires a preliminary card scan.
Before writing, the same NFC session probes OTP installation, reselects Monoid and
authenticates; a missing applet stops before creating any account data.
Supported settings are SHA-1, SHA-256 or SHA-512, 6 or 8 digits, and periods from
1 to 32767 seconds. HOTP is not supported by the current applet.

Read accounts with one List of type `-3583` (`0xF201`). Configuration and alias
come from the list; no Get or HMAC key listing is needed. Adding or deleting reuses
that inventory within the same NFC operation and returns the acknowledged result.
Adding sends one Create with the secret-derived index. EXISTS is accepted only if
View confirms the same configuration, label and secret flag; a difference is a
conflict, not a rename or overwrite. Delete removes only that account; a missing
or incompatible account is skipped. Changed configuration requires scanning again.
Never reuse an inventory across taps or replay an uncertain write.

Enable OTP on card sets `types: [[-3583, false]]` once, with no `keys` entries.
Adding and deleting do not change the grant or implicitly enable OTP. The page
checks current authorization separately while reusing the operation's account
snapshot. A stale installation token requires explicit enabling again.

For provider interoperability, an explicit label prefix takes precedence over a
differing issuer name. Base32 secrets accept nonzero unused bits in the final
symbol, matching Google Authenticator's complete-byte decoding; alphabet, length
and explicit padding checks remain. These display/encoding differences do not
replace algorithm, digits or period values. Regression fixtures use synthetic
secrets, never the contents of a user's QR code.

## Installation and trusted time

Monoid OTP Applet is optional in Card Applets. Its matching Identity, Library and
Monoid dependencies are included in the bundled CAP preparation. Existing
dependency-aware update/reinstall and recovery flows retain the type grant.

Time mode is determined by each tapped card's `Hello.authority`:

- `false`: prepare an unsigned 8-byte big-endian Unix timestamp from the phone.
  No Challenge, network access or APP Authority configuration is needed.
- A service URL: obtain and prepare a signed time proof from that URL. Network,
  signature or card verification failures stop the operation; they never fall
  back to phone time.

Card Applets offers an Authority toggle and an editable Authority URL when
installing Identity for the first time or through Fresh install. Defaults come
from public build configuration:

```dotenv
VITE_AUTHORITY_URL=https://www.monoid.app/
# Optional pin for the configured default site:
VITE_AUTHORITY_PUBLIC_KEY=<65-byte uncompressed P-256 public key in hex>
```

The URL identifies the Authority site, including its login UI, not an API base.
The app adds `api/authority/v1/metadata` or `api/authority/v1/time` internally.
Development defaults to `http://100.69.178.77:8787/` in `.env.development`.
Users can change that URL or disable Authority before installation. Unless the
unchanged default has a pinned build key, fetch and validate its public P-256 key
before prompting for PINs or opening NFC. Dismissing the popup cancels that request;
service failure never silently disables Authority. No private key is used by APP.
Fresh install retains the selected URL and public key with its maintenance
checkpoint so resuming cannot substitute a changed default.

New Identity installations receive `02 || publicKey || UTF8(service URL)` in
their application parameters, or no Authority parameters when omitted. Validate
the pair, P-256 point, URL and GP command length before any card management.
Ordinary updates retain Identity and its time mode. Installing OTP alone does
not change that configuration. Changing the installed URL/key requires the
existing explicit Fresh install flow; the app never initiates it automatically.

For a tapped account, one NFC connection performs:

1. Read the tapped card's identity and Authority mode, selecting its saved Access PIN.
2. Without Authority, OTP Prepare receives phone time and the account index.
   With Authority, OTP Challenge → signed time request → OTP Prepare receives
   the proof and account index.
3. Select Monoid and authenticate Access PIN with the OTP applet AID.
4. Select OTP and Calculate directly, then read the full response before closing NFC.
   The card uses its current configuration and secret; the response supplies the
   period and codes used for display. No View, Get or whole-list scan is needed.

At the start of retrieval, a public metadata request warms the last observed
Authority (or the configured default before a card is known), in parallel with
PIN vault unlock and waiting for NFC. Hello starts the same warm-up for a different
tapped card's URL, overlapping OTP SELECT and Challenge. A known phone-time card
does not warm a service. The hint is kept only in memory, is not tied to an account
or card, and never selects the time mode or changes trust. Warm-up is deduplicated
within the scan, never awaited, and cancelled on exit/completion; failures do not
replace the real signed-time request. No time proofs are prefetched or reused.
Prepare must finish before Access PIN authentication because it revokes the
previous client permission. NFC commands remain sequential.

Scan prompts use `Preparing, hold tight...` for applet selection and Challenge;
`Getting time, hold tight...` covers only the Authority request and local proof
validation. `Verifying time, hold tight...` covers the card's proof verification,
without returning to Preparing. They then distinguish authentication and the actual
`Getting codes, hold tight...` operation. Retrieval wording is plural because one
scan returns three code windows.

For signed time, the app checks the response signature and challenge, then
Identity verifies the proof against its installed P-256 key during Prepare.
The response's public key cannot change the card's trust. The app checks the
returned time against the prepared time and preserves account order in both
modes. Each account returns the current and next two windows. Code selection,
copying and countdown share one continuous monotonic clock and switch at the
same boundary without a blank interval. Local time keeps the sampled millisecond
phase; signed whole-second time uses the request midpoint plus half a second as
its estimated sampling phase. Remote precision is limited by timestamp rounding
and network delay; local time depends on the device clock. Elapsed windows cannot
be copied and the final window expires normally. Codes clear on page exit or app background;
an active NFC operation is cancelled on background. Biometric deactivation before
NFC is allowed to finish normally. Codes are never saved to local storage.

## Resources and transfer

An account is one secret item of type `0xF201`, mapped to HMAC by firmware.
Its data is the 1–255-byte shared secret; metadata is the existing five-byte
`01 || algorithm || digits || period_u16_BE` configuration, and alias is the label.
The index is `F2 01 || SHA-256(secret)[0:8]`, validated by the card. A second
account with the same secret returns EXISTS even with a different configuration
or label. There is no separate HMAC item or key reference. Get cannot reveal the
secret, and changing it requires a new item. Configuration changes require
removal and recreation with the same secret.

Safe Card shows one resource per account. Copy exports and imports that one item
through the Secret-PIN-protected encrypted transfer path; it never reads plaintext
OTP data. Sync keeps it within its own Bundle scope, like other secret items.
Matching indices pin the secret, so different encrypted envelopes are not a
conflict; different configuration under the same index is. Copy keeps an existing
matching destination alias, while Sync uses its existing alias merge rules.
A destination's OTP type grant covers all its accounts, including later imports.
Built-in HMAC `keys` grants do not cover F201.

The cache stores only index, label, algorithm, digits and period. Old cached
entries carrying a key reference are discarded without migration; scan the card
to load current accounts. No compatibility path for the old on-card format is
provided.

Protocol authority: sibling `monoid-javacard/doc/otp.md` and current Java sources.

Software tests cover protocol framing, time proofs/windows, cache boundaries,
PIN ordering, lifecycle cancellation and single-item encrypted transfers. Physical OTP
acceptance still requires the matching card firmware. Signed-time acceptance
additionally requires its configured service and matching Authority key.
