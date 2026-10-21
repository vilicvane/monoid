# Card management

Home → Card Applets owns GlobalPlatform installation and applet maintenance. Safe → Card
owns resources, PIN settings, and bundle setup. Maintenance has two presentations
in the `cardApplets` route: Card information and Card applets. Upload/configuration,
backup/restore progress, and operation errors use the shared NFC presentation.

## Installation and return

- A card with missing Monoid components shows Card versions and Checklist.
  Installation skips existing components.
- Known applets remain visible when their basic information cannot be read. A
  failed read is not evidence that an applet or a capability is absent.
- An unrecognized card manager or explicitly incompatible management protocols
  can show Card not supported. An interrupted communication remains retryable.
- Secret PIN input precedes the installation scan. First initialization also sets
  the initial Access PIN; reinstalling Monoid retains the Identity's Secret PIN.
- Completion is shown only after PIN setup. Copy and bundle setup pass their flow
  ID into the Card Applets route. The verified card is added to that flow before returning,
  without another discovery scan.
- A committed result is delivered to its originating flow even if another route
  takes focus while the NFC presentation closes.

## Update, reinstall, and fresh install

Update and Reinstall replace **Monoid only**. Identity, its Secret PIN, and bundle
membership remain. Fresh install is a separate, explicitly confirmed action that
replaces Identity as well and therefore changes the card identity.

For an unbundled card, ordinary replacement first exports every resource from
`list({})`, including data and address records hidden from the normal resource
view. The archive contains card-encrypted envelopes and the original index, key,
alias, and secret flag. It is bound to the complete Identity public key and
complete caller Applet AID. The persisted archive is read back and checked before
deletion begins.

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
