# Project Memory Records

## 37a3b83

1. [user] integrate card unlock (safe PIN), authentication (access PIN) and similar redirects into `useMonoidApplet`, so later card operations can reuse them. monoid card session flow, setup card redirect, WIP.
2. [agent] card auth state only lives within one NFC session (`CLEAR_ON_DESELECT` since javacard `31cf60a`), so `useMonoidApplet` has to `authenticate` on every tap. session-scoped auth, applet select.
3. [user] ~~when the card is set up but its safe is locked (`hello.safe.unlocked === false`), `useMonoidApplet` redirects to `SetupCardView` under the same condition as not set up, reusing its Unlock safe step.~~ superseded by 8.
4. [user] PIN entry stays on the current page via modal: a missing access PIN is prompted after the tap and used on the next tap; the safe PIN is prompted before the tap. two-tap, `useInputModal`, no route redirect for PINs.
5. [agent] `useMonoidApplet` therefore returns a `ReactNode` (the PIN input modal) for the consumer to render; an entered access PIN is bound to the card id and consumed by the next tap, so it is never tried on another card or retried after failing; it is persisted only after a successful `authenticate`; the safe PIN is never persisted. PIN tries, `MonoidCredentialsStore`.
6. [user] reinstalling a card package clears its persisted data. javacard reinstall, static fields.
7. [agent] hence a MonoidApplet reinstall loses both the access PIN and its stored safe PIN, so in current firmware `hello.safe.unlocked === false` only comes with `hello.pin === false`; `MonoidSafeApplet` handles no APDU and its PIN only changes through MonoidApplet `setPIN`, which keeps the stored copy in sync. set up but locked, redirect condition.
8. [user] keep the `SetupCardView` redirect condition as `hello.pin === false` only, which already brings a locked safe to its Unlock safe step; the extra `!hello.safe.unlocked` check is reverted as unreachable. locked safe, setup card redirect.
9. [user] credentials will eventually live in a separately developed secure storage with chip-encrypted biometric verification; Capawesome Secure Preferences is not truly secure, so during development `MonoidCredentialsStore` uses ordinary persistent storage and migrates later. access PIN storage, biometric.
10. [agent] on `INVALID_PIN` with tries left, `useMonoidApplet` forgets a stored access PIN and prompts again showing the tries remaining; with no tries left it rethrows to `onError` and keeps the stored PIN, since a blocked `OwnerPIN` rejects even the correct PIN; recovering a blocked access PIN is not handled yet. `MonoidAppletInvalidPINError`, `removePIN`, blocked PIN.
11. [user] an access PIN submitted in the wrong format reopens the PIN dialog with the format rule as placeholder, instead of a toast like `SetupCardView`, where retrying is a button press rather than another card tap; dismissing the dialog cancels. PIN format feedback, `MonoidPIN`.
12. [agent] `useMonoidScanPrompt` keeps its own `standby` for now; the WIP placeholder calling `useMonoidApplet` from it was removed, because `useMonoidApplet` listens for taps for as long as it is mounted, so the scan prompt can only build on it once the hook can be activated on demand. scan prompt rebuild, WIP checkpoint, `SetupCardView` redirect loop.
13. [user] the project is old, so point out whenever the user's choices conflict with the interactions its existing code implies. collaboration, legacy code intent.
14. [agent] the app (Ionic React + Capacitor, Android) drives the card applets developed in the sibling repo `monoid-javacard`, which owns the card protocol; the app mirrors its commands as x-value schemas in `src/@lib/monoid/monoid-applet.ts`, on top of the generic `CBORApplet`/`Applet` transport in `src/@lib`. card protocol source, CBOR, javacard.
15. [agent] card facts the app relies on: `hello.pin` and `hello.safe.pin` report tries remaining, or `false` when never set (access PIN limit is 5 tries); `INVALID_PIN` carries the remaining `tries` inside `error`; `list`, `view`, `viewKey` and `sign` need session access auth and `get` needs safe auth, with no `auth` request field; `setPIN({pin, safe: true})` also sets the access PIN when it is unset, and once the safe PIN is set every `setPIN` needs safe auth from `authenticate({pin, safe: true})` in the same session. hello, setPIN, PIN tries.
16. [agent] the WIP identifies a card by MonoidApplet's `hello.id` (`MonoidIdHex`) instead of the safe id, in the setup card route, `ScannedCardData`, `MonoidData` and the card header; it is 4 TRNG bytes generated once at MonoidApplet install, and stored access PINs are keyed by it. card identity, safe id.
17. [agent] pushing a sibling routra route unmounts the previous view, and `$back()` remounts it with fresh component state (only route `$state` survives), so a PIN route would lose the calling view's progress; this is why PIN entry is a modal (record 4). routra unmount, local state loss.
18. [agent] the NFC plugin receives tags through Android foreground dispatch, so a new `nfcTagScanned` event needs the card lifted and tapped again; `useInputModal` replaces a pending dialog on a new `show` without resolving it. So the `standby` callback opens the PIN dialog without awaiting it and returns, letting `Nfc.close()` end the session; awaiting would hold the connection open, and a re-tap would leave that await pending forever. two-tap, `void showPINInput`, `Nfc.close`.
19. [agent] firmware drift: since javacard `42eda62`, `hello.features.curves` is `[{name, ciphers}]` with no top-level `ciphers`, but the app's `hello` schema still expects `features: {curves: CurveName[], ciphers: CipherName[]}`; responses are checked with `satisfies`, so `hello`, and with it every `useMonoidApplet` tap, throws on that firmware until the schema is aligned; when to align is not decided. hello features, schema mismatch.
20. [agent] the app's `Applet` transport sends each request as a single short APDU (CLA 00, one-byte Lc) and reads `61xx` remainders with GET RESPONSE using CLA 00; it lacks the firmware's multipart framing (CLA 00/90/B0/A0 since javacard `8abf0c5`), so CBOR requests over 255 bytes are not supported yet. short APDU, large sign requests.
21. [agent] `useMonoidApplet` progress: `auth: 'access'` is complete (records 4–5, 10–11) and used by `ScanCardView`; `auth: 'safe'` still throws a TODO error; a blocked access PIN only reaches `onError`. WIP, card session refactor.
22. [agent] `DeriveKeyView` still calls `monoidApplet.standby` directly and, since the WIP removed its hard-coded `viewKey` `auth`, never authenticates, so deriving fails on current firmware; moving it onto `useMonoidApplet({auth: 'access'})` would fix that. WIP, derive key.
23. [agent] `SetupCardView` still sends an `auth` field inside `setPIN`, which `CommandSetPIN` ignores in favor of session auth, so unlocking a set-up safe fails with `UNAUTHORIZED` until it calls `authenticate({pin, safe: true})` first; setting the safe PIN on a new card needs no auth and works; step 2 has only unused state. WIP, setup card, unlock safe.
24. [agent] `MonoidStorageService` (`monoids` storage key, `MonoidData` holding only `id`) is still an empty stub whose constructor ignores `storage`. WIP, card list storage.
25. [agent] verification on Windows: from the repo root run `npx tsc --build --pretty false` (clean at this checkpoint) and `npx prettier --check <files>`; ESLint only works from `src` (from the root it reports "TSConfig does not include this file"), and `@`-prefixed paths must be quoted in PowerShell. Lint baseline at this checkpoint is 14 errors: 12 already at `HEAD` in `@app.tsx`, `use-input-modal.tsx` and `setup-card-view.tsx`, and 2 from the `MonoidStorageService` stub. tooling, lint baseline.

## d0ac890

26. [user] use the roomy wallet-list layout on the Transactions wallet selection page; roomy spacing should be the default when a wallet list is the main content of a page. wallet list density, shared layout.

## e5116ec

27. [user] implement comprehensive iOS support for this app, including the missing native functionality; updating Capacitor as needed is allowed, and the Java Card firmware is available in sibling `../monoid-javacard`. iOS integration.
28. [agent] use Capacitor 8.5.3 with Swift Package Manager and iOS 15 minimum; Node 22.12+ is required. Xcode 27 uses Device Hub, so `npm run ios` syncs and opens Xcode instead of relying on native-run's obsolete Simulator.app path. development environment.
29. [agent] iOS NFC uses foreground Core NFC sessions and an explicit ISO7816 AID allowlist, including both bundled full AIDs and the version-independent runtime SELECT prefix; close its system sheet before web PIN/error UI, and return errors instead of automatic iOS retaps. Preserve cancellation/timeout and uncertain APDU outcomes; do not replay mutations. Core tradeoffs and device checks: [29.md](29.md).
30. [agent] iOS vault scopes authenticate once for up to 60 seconds using Keychain `biometryCurrentSet` and `whenPasscodeSetThisDeviceOnly`, revoke on background/lock/close, and offer no passcode fallback; invalidated items may appear missing and Keychain may survive uninstall. See [29.md](29.md). credential protection.
31. [agent] records 19–24 describe an obsolete WIP: current code has `useMonoidScanPrompt`, biometric Access PIN scopes, explicit Safe PIN flows, persisted card management, aligned hello curve/cipher schemas and multipart APDUs. Stored Access PINs preload before NFC; modal input and deferred saves wait for reader cleanup, every retap reauthenticates, and Safe PINs are never persisted. The old 14-error lint baseline in record 25 is historical. card session snapshot correction.

## 5d63a15

32. [user] after checking the iOS system NFC completion sound, keep Monoid's card sounds consistent with Silent Mode: mute them when the phone is silent. This supersedes the earlier request to play in Silent Mode. audio behavior.
33. [agent] the shared `MonoidUITests` scheme resets only `app.monoid` camera authorization, accepts its first-use prompt and verifies the preview stays active without page switching; physical validation exposed authorization callbacks preceding deactivation while both app and scene still report active, requiring an explicit subsequent app-activation barrier. See [29.md](29.md). camera permission UI regression.

## 512c9fd

34. [agent] physical iOS feedback fixes: bundled WAV fetches return readable `basic` responses with status 0, and card removal during APDU exchange can return Core NFC 102 while the tag is unavailable and reader ready. Accept the media response and classify only the corresponding unavailable-tag transfer failures as `TAG_LOST`, preserving Silent Mode, other error classes and unknown APDU outcomes. Preserve tag loss through cleanup so the system sheet ends with a disconnect message instead of a success checkmark; normal post-read removal remains successful. See [29.md](29.md). audio loading, NFC removal.

## 3c16089

35. [user] automatically resume both the main QR scanner and Bitcoin QR popup when returning to the app; remove the Bitcoin scanner's Cancel button, and do not show the loading spinner when cancelling a scan. The spinner belongs to the main scanner's link processing. QR foreground recovery, scanner presentation.
36. [agent] QR foreground recovery creates a fresh scan ID only after the previous camera stops successfully and the app is active and visible. Share lifecycle coordination across both scanners, tolerate delayed native pause events, and limit recovery to one attempt per foreground transition; dismissed, leaving, accepted-result, permission-denied and hardware-error states do not resume. This camera behavior does not change NFC's no-replay policy. QR lifecycle ownership.

## 5409391

37. [user] resuming QR scanning should keep the full preview size and fade out its cover once the camera is ready, without repeating the entry zoom animation. QR recovery motion.
38. [agent] Core NFC exposes dynamic system-sheet text but no public spinner/progress-animation control. Mirror the rendered scan prompt's real stage/count text through a session-bound `setSessionMessage` API; only the current connected session accepts updates, and late updates cannot replace removal/disconnection messages. This is presentation only and must not send/replay APDUs or affect operation results. See [29.md](29.md). NFC progress feedback.

## d099e17

39. [user] after confirming the iOS NFC system sheet updates its text, keep it from reverting to the initial hold-card prompt when finishing; timing out without a card tap should close quietly without an app error. NFC dismissal feedback, idle timeout.

## 09ed49b

40. [user] the final in-progress text is misleading at scan completion; clear it or show an explicit completion message instead. NFC completion presentation.

## 7c1bbb9

41. [user] use an empty string for the scan's final message instead of `Completed.`; confirmed on the physical iPhone that the system sheet finishes with no prompt text. NFC completion presentation.

## 8aac0c2

42. [user] implement Passkeys with a Home entry for account management using the current interaction and visual design; both QR and system-provider use are wanted, but start with one and prioritize iOS. The user proposed opening the main app before tapping the card. Passkey scope and sequence.
43. [agent] the full app-level Passkey experiment is removed: Home entry, local account-management pages/storage, Passkey-specific card wrappers, iOS provider, native/shared request bridge and notification handoff. Preserve the preexisting generic card protocol, P-256, Safe and NFC functions. Physical failure, request-delivery lessons, historical derivation design and the iOS BLE Service Data limitation for standard remote FIDO hybrid are recorded in [43.md](43.md); no Passkey UI or transport remains in the app.
44. [user] physical testing showed that swiping out of the Passkey extension closed its sheet; the later notification opened Monoid but also dismissed the sheet, which did not return on switching back. Notification navigation did not preserve the system request. See [43.md](43.md).
45. [user] pause and clean up the local iOS provider direction, record the lessons and prioritize remote Passkey use. Direct NFC authentication was originally intended to be implemented by installing the corresponding applet on the card. Passkey scope correction.

## 2880f00

46. [user] after repeated HTTP WebView ID-generation regressions, record the constraint in project memory instead of adding a lint restriction. [agent] the physical Android app's HTTP development origin has `isSecureContext === false` and no `crypto.randomUUID`, while `crypto.getRandomValues` is available. Copy and Bundle use the shared `createFlowId()` helper in `src/@utils/miscellaneous.ts`; new flow IDs must reuse it. Do not reintroduce `crypto.randomUUID` in app code or assume desktop localhost and Node tests represent the phone's environment. Existing QR/NFC scan IDs already use `getRandomValues`; keep their HTTP compatibility. Regression tests must remove `randomUUID` and exercise the real route initializer, not only mock the button's router call. Web Crypto secure-context availability, silent navigation failure.

## a4d5a46

47. [agent] a rejected Access/Secret PIN or other application failure must end the iOS NFC sheet with its error indicator, even when the APDU transport succeeded. Carry trusted PIN/card text (generic fallback for other errors) through `closeSession.errorMessage`, retain it until `stopScan`, and preserve native cleanup before PIN input or app error handling. This presentation must not change transport events, consume extra PIN attempts, or replay operations; success retains an explicit completion message or otherwise clears its final text. See [29.md](29.md). NFC business-failure completion.
