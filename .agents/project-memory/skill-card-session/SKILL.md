---
name: project-memory-card-session
description: Monoid NFC card sessions, Access/Safe PIN ownership, biometric vault scopes, multipart transport and iOS system-sheet constraints. Use for NFC operations, PIN prompts, useMonoidScanPrompt or views that communicate with cards.
---

# Monoid card sessions

Source: `../records.md`, especially records 29–32, 34, 38–41, 47 and 49–50, and `../29.md`. Treat records
as authoritative and keep them up to date. Records 19–24 describe an older WIP;
do not reintroduce their plain-storage design or assume those TODOs still exist.

- `useMonoidScanPrompt` owns card presentation, retries, PIN input and deferred
  credential saving. `useIsoDepScanPrompt` handles raw card operations such as
  GlobalPlatform setup. Both await native cleanup and presentation exit.
- Display confirmed card previews, derived addresses and verified completion from
  the successful card callback so the underlying UI updates during the iOS
  checkmark. Keep navigation, PIN dialogs, Copy/Bundle handoffs and next-scan
  controls behind the existing cleanup/credential barrier. Do not resolve scan
  promises early: leaving the owning view can abort deferred PIN saving. Failed
  or cancelled callbacks must not publish success or replay uncertain mutations.
- Access PINs preload through `MonoidPINSession` before NFC starts. Page-owned
  sessions may span related operations; temporary sessions dispose with the scan.
  They retain plaintext only for the owning flow. Persistent storage uses the
  biometric vault; the unencrypted backend is an explicit development-only option.
- A missing PIN ends the current reader before presenting a modal. Bind typed
  PINs to the card's `hello.id`, verify the intended card before credentials, and
  authenticate again on every tap. Do not await a web modal inside a live card
  callback. Save a successfully verified Access PIN after native cleanup.
- Safe PINs are entered explicitly and never persisted. Initialization only copies
  the Safe PIN to Access PIN when Access PIN is unset. Changed card/Safe identity
  invalidates a pending setup PIN. Wrong-PIN retries respect firmware tries.
- iOS Core NFC covers the WebView and has a system session limit. Errors close
  the sheet and return to the caller; no automatic iOS retry hides the error or
  replays an uncertain mutation. Cancellation and iOS timeout before any card
  connection attempt remain quiet; connection/operation timeouts stay explicit.
- Mirror rendered scan stage/count text to the iOS sheet with session-bound
  `setSessionMessage`; clear the presentation's session ID on disconnect. Stale
  messages cannot overwrite removal or disconnect feedback, and message failures
  must not change APDU outcomes. Public Core NFC does not expose spinner control.
  Successful card operations default to clearing their final text with
  `closeSession.message` set to an empty string; an explicit callback completion
  message takes precedence. Both are written atomically before ending the connection. Omitted
  message preserves existing text; an empty string must not be treated as omitted.
  PIN input, redirects, cancellation and failure do not trigger this success-only
  clearing. Only an explicit removal gate restores the initial hold-card prompt.
- A wrong PIN or other application failure can follow a successful APDU exchange.
  Use `closeSession.errorMessage` to end the iOS sheet with an error indicator,
  retaining trusted PIN/card text until `stopScan`; unknown errors use generic text.
  This closes discovery without changing transport outcomes or firing scan-ended
  events early. Still await native cleanup before PIN input or application errors.
  Missing PIN input remains a normal handoff; failed PINs never retry automatically.
- Card sounds respect the iPhone Silent Mode switch, matching the user's final
  preference after checking the system NFC completion sound.
- During an iOS APDU exchange, Core NFC response/retry errors count as `TAG_LOST`
  only when the tag is unavailable and the reader is still ready. Preserve other
  errors and unknown APDU outcomes; lost connections cancel without replaying.
  End the system sheet with a disconnect error for tag loss; successful post-read
  removal retains the normal completion indication.
- iOS requires the applet/card-manager AIDs in `Info.plist`. Keep them aligned with
  both the bundled CAP manifest and actual SELECT bytes, including the normal
  version-independent Monoid prefix `F06D6F6E6F69640201`. Native removal detection
  does not send probe APDUs.
- iOS vault access uses a fresh biometric authorization per explicit scope, at
  most 60 seconds, revoked on background/lock/close. Never weaken to passcode or
  general device-unlocked access. Missing/inaccessible credentials allow manual PIN.
- Firmware in sibling `monoid-javacard` is the protocol authority. Current
  `Applet` transport sends 255-byte multipart frames (CLA 00/90/B0/A0), supports
  1–8192-byte encoded requests, and reads `61xx` with GET RESPONSE. Schemas are in
  `src/@lib/monoid/monoid-applet.ts`; inspect current firmware for changes.
