---
name: project-memory-card-session
description: Monoid app card session flow and its in-progress refactor. Covers `useMonoidApplet`, the setup-card redirect, access/safe PIN entry and storage, the card protocol facts the app relies on, firmware drift, and what is still unfinished. Use when working on NFC card operations, PIN prompts, `useMonoidScanPrompt`, or any view that talks to the card.
---

# Monoid app card session

Source: `../records.md`, records 1–12 and 14–24.

## Status

The refactor integrates the card setup redirect, access PIN authentication and safe PIN unlocking into `useMonoidApplet` (`src/@components/@monoid/use-monoid-applet.ts`), so later card operations can reuse them. At this checkpoint it type-checks cleanly.

- Done: `auth: 'access'`, used by `ScanCardView`.
- Not built: `auth: 'safe'` (throws a TODO error), and recovery of a blocked access PIN (it only reaches `onError`).
- `useMonoidScanPrompt` still runs its own `standby`. It can only build on the hook once the hook can be activated on demand: the hook listens for taps for as long as it is mounted, so calling it from the scan prompt would make every tap in `SetupCardView` push another `SetupCardView`.
- Compiles but fails on current firmware:
  - `DeriveKeyView` calls `monoidApplet.standby` directly and never authenticates. Moving it onto `useMonoidApplet({auth: 'access'})` would fix it.
  - `SetupCardView` unlocks a set-up safe by sending `auth` inside `setPIN`, which the card ignores, so it gets `UNAUTHORIZED`; it must call `authenticate({pin, safe: true})` first. Setting the safe PIN on a new card works. Step 2 has only unused state.
- `MonoidStorageService` (`monoids` storage key, `MonoidData` holding only `id`) is an empty stub.
- Two kinds of firmware drift remain; see the last section.

## Flow decisions

- Every tap starts with `hello`. If `hello.pin === false` (a new card, or MonoidApplet reinstalled, which clears its persisted data), push `SetupCardView` with `{id, pin, safe: {id, pin, unlocked}}` and stop. Keep this as the only redirect condition: in current firmware a locked safe (`hello.safe.unlocked === false`) only occurs together with `hello.pin === false`, so it already lands on the Unlock safe step.
- Card auth lasts one NFC session, so the hook authenticates on every tap.
- PIN entry is a modal on the current page, never a route: a routra sibling push unmounts the calling view, and `$back()` remounts it with fresh state. The hook returns the dialog as a `ReactNode` that the consumer must render.
- Access PIN: use the PIN typed for this card after the previous tap, otherwise the stored one. If neither exists, open the dialog and end the session; the typed PIN is used on the next tap. A typed PIN is bound to the card id, consumed by the next tap and never retried, and stored only after `authenticate` succeeds.
- Wrong PIN with tries left: forget the stored PIN if that was the one used, and reopen the dialog showing the tries remaining. No tries left: rethrow to `onError` and keep the stored PIN, because a blocked `OwnerPIN` rejects even the correct PIN.
- A submitted PIN that fails `MonoidPIN` reopens the dialog with the format rule as placeholder, rather than showing a toast as `SetupCardView` does; dismissing the dialog cancels.
- Open the dialog with `void showPINInput(...).then(...)`, never awaiting it inside `standby`. The callback must return so `Nfc.close()` ends the session; Android foreground dispatch only reports the card again after it is lifted and re-tapped, and `useInputModal` replaces a pending dialog without resolving it, so an awaited dialog could stay pending forever.
- Safe PIN (planned): prompted before the tap, never stored.
- `MonoidCredentialsStore` keeps access PINs in ordinary `StorageService` storage (`monoidPINs`, keyed by `MonoidIdHex`) during development. They will move to a separately developed secure storage with chip-encrypted biometric verification; Capawesome Secure Preferences is not considered truly secure.
- A card is identified by MonoidApplet's `hello.id` (4 TRNG bytes generated once at install), not by the safe id.

## Card protocol facts

- The sibling repo `monoid-javacard` owns the protocol; the app's command schemas are in `src/@lib/monoid/monoid-applet.ts`.
- Auth set by `authenticate` is cleared on deselect (since javacard `31cf60a`). `list`, `view`, `viewKey` and `sign` need access auth and `get` needs safe auth; none takes an `auth` request field.
- `hello.pin` and `hello.safe.pin` report tries remaining, or `false` when never set. The access PIN allows 5 tries.
- `INVALID_PIN` errors carry the remaining `tries` inside `error`; the app matches them with `MonoidAppletInvalidPINError` on `CBORAppletError.source`.
- `setPIN({pin, safe: true})` also sets the access PIN when it is unset. Once the safe PIN is set, every `setPIN` needs safe auth from `authenticate({pin, safe: true})` in the same session.
- `MonoidSafeApplet` handles no APDUs; its PIN only changes through MonoidApplet `setPIN`.

## Drift from current firmware

- Since javacard `42eda62`, `hello.features.curves` is `[{name, ciphers}]` with no top-level `ciphers`, while the app's schema still expects `{curves: CurveName[], ciphers: CipherName[]}`. Responses are checked with `satisfies`, so `hello`, and with it every `useMonoidApplet` tap, throws on that firmware. The fix is schema-only; when to make it is not decided.
- The app sends each request as one short APDU (CLA 00, one-byte Lc) and reads `61xx` remainders with GET RESPONSE using CLA 00. It lacks the firmware's multipart framing (CLA 00/90/B0/A0, since javacard `8abf0c5`), so requests over 255 bytes of CBOR are not supported yet.
