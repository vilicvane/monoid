---
name: project-memory-card-session
description: Monoid NFC card sessions, Access/Safe PIN ownership, biometric vault scopes, multipart transport and iOS system-sheet constraints. Use for NFC operations, PIN prompts, useMonoidScanPrompt or views that communicate with cards.
---

# Monoid card sessions

Source: `../records.md`, especially records 29–32, 34, 38–41, 47–50, 63 and 83, and `../29.md`, `../48.md` and `../50.md`. Treat records
as authoritative and keep them up to date. Records 19–24 describe an older WIP;
do not reintroduce their plain-storage design or assume those TODOs still exist.

- `useMonoidScanPrompt` owns card presentation, retries, PIN input and deferred
  credential saving. `useIsoDepScanPrompt` handles raw card operations such as
  GlobalPlatform setup. Both await native cleanup and presentation exit.
- Access PINs preload through `MonoidPINSession` before NFC starts. Page-owned
  sessions may span related operations; temporary sessions dispose with the scan.
  They retain plaintext only for the owning flow. Persistent storage uses the
  biometric vault; the unencrypted backend is an explicit development-only option.
- When both vault unlock and manual PIN input are required, unlock first, then
  open the PIN input. Reuse that session for later Access PIN saving; do not add
  unlocks to Secret-only operations. Access PIN setup/update uses `getPINs` to
  preserve manual fallback when protected storage is unavailable. See `../48.md`.
  After unlock, check cancellation/page activity before input or NFC. Clear a
  failed unlock session so an explicit retry can authorize again. Keep successful
  borrowed sessions page-owned and dispose temporary sessions when finished.
- If Access PIN saving reports `AUTHORIZATION_EXPIRED`, `MonoidPINSession.setPIN`
  disposes the expired access, shares one renewed unlock and retries only the
  local save once. Preserve the native 60-second lifetime; never replay card
  work or renew on cancellation/background/closed access/other storage errors.
  Abort and page exit cancel renewal. A failed renewal or second expiry keeps
  the existing save warning. Read/removal operations do not automatically renew.
- Keep PIN inputs remounted per prompt. On Android, DOM autofocus after biometric
  unlock may not open the IME: use the shared input modal's explicit keyboard
  request, which waits for native window focus. Cancel pending keyboard work on
  prompt close/replacement/abort/unmount. Never blur/refocus to recover the IME
  (blur cancels the input), or reopen it after a user dismissal. See `../48.md`.
- A missing PIN ends the current reader before presenting a modal. Bind typed
  PINs to the card's `hello.id`, verify the intended card before credentials, and
  authenticate again on every tap. Do not await a web modal inside a live card
  callback. Save a successfully verified Access PIN after native cleanup.
- Secret PINs are entered explicitly and never persisted. New Secret and Access
  PINs require confirmation; initialization/Reset defaults to a separate Access
  PIN, with an unchecked option to reuse the confirmed Secret PIN. Restore an
  unset Access PIN from the unlocked local vault when available; otherwise ask
  for it twice. Existing Secret PIN authentication needs one entry. Firmware
  initially copies a new Secret PIN to Access PIN; authenticate Secret before
  writing a distinct Access PIN on that connection. Changed card identity
  invalidates pending input. Wrong-PIN retries respect firmware tries. See record 59.
- Every plaintext PIN held in JS memory goes through `HeldPINValue`/`HeldPINs`:
  dropped after 5 idle minutes per holder or when `isAppHidden()` (lock, app
  switch), never on inactive-only states. Android WebView stays `visible` on
  lock, so Android also uses `appStateChange` false (`onStop`); never use it on
  iOS (`willResignActive`). Only clear/expiry/hide abort the owner; capture it
  before awaiting a write. See record 83.
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
- Feature pages skip incompatible records individually; Copy, Sync and backup
  treat items as opaque and report undecodable records, conflicts and import
  rejections per item while the rest finish (record 71). Only local format errors
  qualify, not NFC, PIN, cancellation or uncertain mutations. Do not delete the
  skipped on-card items or overwrite them as if absent. Destructive maintenance
  still requires complete recovery data. The temporary old `key`/`keyPrefix`
  protocol adapter was removed at the user's request; use only the current
  metadata fields. See `../50.md` for the separate Identity Bundle packet
  incompatibility, which APP cannot repair by changing packet headers.
- OTP time mode comes from the current card's required `Hello.authority`: false
  accepts phone time without Challenge/network; a URL requires its signed time
  proof, with the installed Identity key as the final verifier. Never fall back
  after a service, signature or card rejection. Prepare precedes client-bound
  Access PIN authentication in the same NFC session. Optional Identity Authority
  installation parameters require URL and public key together; ordinary Monoid
  replacement preserves them. See record 56.
- Every Security Key `0xF101` record is resident; non-resident credentials have no
  record and recover from the granted Seed and domain alone. Decoding ignores
  record field 8. Replacing any bound Seed asks for confirmation, because
  non-resident accounts may exist without a visible record. See record 63.
