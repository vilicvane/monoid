# Card management

Home → Card Applets owns GlobalPlatform installation and applet maintenance. Safe → Card
owns resources, PIN settings, and bundle setup. Maintenance has two presentations
in the `cardApplets` route: Card information and Card applets. Upload/configuration,
backup/restore progress, and operation errors use the shared NFC presentation.

## Installation and return

- A card with missing Monoid components shows Card versions and Checklist.
  Installation skips existing components.
- Installing Identity or choosing Fresh install offers an optional Authority and
  an editable Authority URL using the shared toggle and popup input. The URL is
  the site root; API paths are added by APP. Resolve its public key before PIN or
  NFC prompts, and retain that exact pair if Fresh install needs to resume.
  Installing optional applets, updating and ordinary reinstall preserve Identity's
  existing Authority configuration and do not show these settings.
- Known applets remain visible when their basic information cannot be read. A
  failed read is not evidence that an applet or a capability is absent.
- An unrecognized card manager or explicitly incompatible management protocols
  can show Card not supported. An interrupted communication remains retryable.
- PIN input precedes the installation scan. New Secret and Access PINs each
  require confirmation. The Secret PIN prompt defaults to a checked "Set a
  different Access PIN" checkbox; unchecking uses the confirmed Secret PIN as
  Access PIN without another input. Reinstalling Monoid retains Identity's
  Secret PIN and restores the saved Access PIN when this device has it.
- Completion is shown only after PIN setup. Copy and bundle setup pass their flow
  ID into the Card Applets route. The verified card is added to that flow before returning,
  without another discovery scan.
- A committed result is delivered to its originating flow even if another route
  takes focus while the NFC presentation closes.
- Setup returns to its actual source: Copy-origin setup returns to Copy, while
  Card-origin bundle setup returns to Card on completion or an uncertain creation
  result. Safe is the fallback when the source is no longer in history. An older,
  unrelated Copy entry must not determine the destination.
- Copy completion offers Back to Card when Card exists in route history,
  otherwise Back to Safe. If neither destination exists, no return button is shown.

Copy retains each acknowledged import and completes a destination as soon as all
its items are acknowledged, without a final inventory reread. An interrupted,
unacknowledged import retries the same envelope through the card's idempotent
import command. A bundled source exports each selected item once and shares that
envelope with its other enrolled destination cards; an unbundled source still
exports separately for each recipient public key.

## Update, reinstall, and fresh install

Update and Reinstall replace **Monoid only**. Identity, its Secret PIN, and bundle
membership remain. Fresh install is a separate, explicitly confirmed action that
replaces Identity as well and generates new cryptographic keys. It preserves the
original four-byte Card ID when available from Hello or a retained maintenance
record for that physical card. The ID is persisted before deletion, supplied to
Identity installation alongside optional Authority settings, and checked after
installation, including verify-only resumes. If no original ID can be read or
recovered, Identity generates an ID. Preserving the display ID does not retain
PINs, items, keys or Bundle membership.

Initial inspection uses the public GP registry. If the card requires authentication
(`6982`) but Monoid still answers Hello, Update and Reinstall open the GP secure
channel to confirm the exact instance AID before backup. Other registry failures
remain errors, and a successful prefix SELECT never supplies an assumed AID.
Monoid is selected and its Secret PIN authenticated again after this query.

For an unbundled card, ordinary replacement first exports every resource from
`list({})`, including data and address records hidden from the normal resource
view. The archive contains card-encrypted envelopes and the original index, metadata,
alias, and secret flag. It is bound to the complete Identity public key and
complete caller Applet AID. The persisted archive is read back and checked before
deletion begins.

The persisted recovery format keeps its existing `key` field for item metadata
so saved archives and their checksums remain intact. The card protocol uses
`metadata`; the maintenance service maps it at the storage boundary.

Restoration imports the complete archive, then verifies identity and the complete
inventory. Only that successful verification removes the matching archive.
Interrupted work survives navigation and application restart. Physical production
information locates an interrupted installation while Monoid is absent; it does
not authorize importing an archive into another Identity.

Bundle members cannot recover their own exported envelopes. Ordinary replacement
therefore requires confirmation that the user has copied data to another member.
The app retains a reminder to restore from that member afterward. This workflow
does not automate bundle data recovery.

Fresh install does not delete an existing recovery archive. An archive belonging
to the former Identity cannot be restored into the new Identity. Unknown APDU
outcomes stop the current operation. A subsequent explicit retry reads the
registry and resumes its saved checkpoint instead of restarting deletion.

The resource cache is invalidated when replacement begins. The phone's imported
keys and addresses are not removed by this cache invalidation.

## Versions and protocol

GP package versions and Monoid's Hello version are separate values; neither is an
installed-code hash. The app records bundle hashes only for components it actually
installed. A later bundled Monoid hash can then identify an update for that known
installation. Existing or merely instantiated packages are not labeled as the
current bundle without evidence.

The current protocol uses `pins.secret`, authentication with `secret: true`, and
Secret PIN authorization for both Export and Import. Secret PINs are never saved.
PIN authorization is re-established after SELECT. Ordinary replacement refuses a
changed caller AID or an unreadable/incompatible Identity; it never silently
converts to Fresh install.

Within one scan, the completion snapshot reuses the card's already-read GP
information. Installation and replacement still refresh the applet inventory;
PIN-only setup keeps that inventory and uses the updated Hello response.

## Bundle collection

Adding an existing bundle member requires the reset warning and confirmation.
The app collects the new Secret PIN first, then resets and initializes the card
in one scan. Reset changes the Identity. Only the new identity is added to the
membership list.

The second round seals the bundle in any order. It performs Create/Join only.
Reset is never deferred until after enrollment packets have been constructed.
If Reset succeeds but its new identity cannot be read, the app does not replay
Reset or bind an arbitrary later card to that result.

## Validation boundary

Automated tests cover registry deletion, archive persistence and restoration,
identity checks, uncertain outcomes, PIN sequencing, route handoff, and bundle
collection. They do not establish compatibility or NFC reliability on physical
cards. Installation and Hello success also do not constitute a cryptographic
self-test of every Monoid operation.

## PIN setup and recovery

The shared PIN input flow is used by Safe scanning, Card Applets installation,
Fresh install, Copy destination initialization and Create/Extend bundle card
initialization or Reset. Unlock the Access PIN vault before manual input. Collect
all new credentials before starting the write scan. Each confirmation is local
input matching, not another on-card authentication attempt.

- Both PINs unset or an explicit Reset/Fresh install: confirm the new Secret PIN
  twice and, by default, the new Access PIN twice. Old stored Access PINs are not
  reused. Fresh replacement removes the obsolete local PIN after installation.
- Existing Secret PIN with missing Access PIN: enter the Secret PIN once. Restore
  the saved Access PIN without input; if none exists, enter the new Access PIN
  twice. Never silently replace Access PIN with Secret PIN.
- Both PINs already set: do not set either again. Ask existing Secret PIN only
  for operations requiring that authorization; ordinary Access authentication
  uses the saved PIN or one manual entry. Verified Secret PINs are reused only
  within their owning visible flow and are never persistently stored.
- Update Secret PIN: enter the current Secret PIN once, then the new Secret PIN
  twice. Access PIN is unchanged and the separate-PIN checkbox is absent.
- Update Access PIN: enter the current Secret PIN once, then the new Access PIN
  twice. Secret PIN is unchanged.

An interrupted flow reads current PIN state rather than replaying writes. A
new Secret PIN initially sets the same Access PIN in firmware; selecting a
different Access PIN then authenticates with Secret PIN and writes the selected
Access PIN on the same NFC connection. Only the successfully verified Access PIN
is saved. A lost response is not permission to retry a PIN mutation automatically.
