# capacitor-biometric-vault

Private Capacitor 7 plugin for storing small secret text values. Authenticated
access requires Android 11 (API 30) or later. There is no web or iOS implementation.
The plugin registers as `BiometricVault`; application schemas and credential
workflows remain outside the plugin.

## API

```ts
import {BiometricVault} from 'capacitor-biometric-vault';

async function updateSecret(id: string, signal: AbortSignal): Promise<void> {
  await using vault = await BiometricVault.authenticate({
    reason: 'Unlock saved credentials',
    signal,
  });

  const {value} = await vault.get({id});
  const updated = await updateBusinessValue(value, signal);
  await vault.set({id, value: updated});
}
```

| Method                                           | Result                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `BiometricVault.getAvailability()`               | `{biometrics: 'available' \| 'not-enrolled' \| 'unavailable' \| 'unsupported' \| 'unknown'}` |
| `BiometricVault.authenticate({reason, signal?})` | A `BiometricVaultAccess` after one strong biometric prompt                                   |
| `vault.get({id})`                                | `{value: string \| null}`; `null` means a missing entry                                      |
| `vault.set({id, value})`                         | Atomically stores or replaces a protected text value                                         |
| `vault.remove({id})`                             | Deletes an entry using the open access                                                       |
| `vault[Symbol.asyncDispose]()`                   | Closes access and waits for outstanding operations and cleanup                               |
| `BiometricVault.remove({id})`                    | Deletes an entry without authentication, including unusable entries                          |
| `BiometricVault.clear()`                         | Deletes this plugin's records and cleans up its keys without authentication                  |

`id` and `reason` must be nonblank; whitespace is preserved. IDs are limited to
512 UTF-8 bytes and reasons to 256 characters. Values may be empty and are limited
to 64 KiB in UTF-8. Strings must contain valid Unicode without unpaired UTF-16
surrogates. Request IDs and access IDs are internal bridge details.

The access implements `AsyncDisposable`; use `await using` or explicitly await
`Symbol.asyncDispose` in a `finally` block. Synchronous `using` is not supported.
The TypeScript consumer needs `ESNext.Disposable` in its libraries; its compiler
must lower `await using` for older WebViews. The package supplies the runtime
`Symbol.asyncDispose` symbol when needed.

## Access lifetime and operation ordering

Android access has a fixed 60-second lifetime after successful authentication.
Reads and writes do not renew it or display another prompt. Expiry reports
`AUTHORIZATION_EXPIRED`; the application decides whether to start a new flow.
The plugin never replays business work automatically.

Native code validates access, foreground state and a monotonic deadline when a
queued operation executes and before committing a change or returning plaintext.
Backgrounding or destroying the activity revokes access independently of
JavaScript cleanup. Closing access prevents further use of an escaped object.

The optional `AbortSignal` cancels pending authentication and remains attached to
the resulting access. Aborting initiates closure and cancellation of uncommitted
operations; `abort()` itself does not wait. Awaited disposal closes the scope and
waits for outstanding operations and cleanup attempts. It reports failures
exposed by the native close call; operation failures belong to their original
promises. A write that has
already committed remains successful even if cancellation arrives before its
JavaScript result. An asynchronous business callback must itself cooperate with
cancellation.

Native operations execute through one FIFO queue. An open access does not occupy
the queue while the application waits for card interaction or other work. Each
write is atomic: a failure before commit preserves the previous value. Multiple
operations within one access are not a database transaction and do not provide
rollback or isolation from another access. Applications must serialize their own
read-modify-write sequences when necessary.

Availability checks do not prompt and do not guarantee a usable protected key.
Authentication, invalidation and storage errors are not converted to missing
values. An explicit `set` may replace an invalidated or corrupted entry; a failed
read never silently replaces or deletes it.

## Protection and platform boundaries

Android uses AES-256-GCM keys held by Android Keystore and protected by secure
hardware. The plugin verifies hardware-enforced authentication, strong
biometric-only authorization, the 60-second window and invalidation on biometric
enrollment changes. Device-credential fallback and software-only keys do not
satisfy this policy. Unsupported protection reports
`HARDWARE_SECURITY_UNAVAILABLE`; Android versions before API 30 report
`UNSUPPORTED` for authenticated access.

There are two lifetimes: the plugin's access scope and Keystore's system
authentication window. Disposing or aborting closes the plugin's access early;
it does **not** revoke the system's biometric authentication window. Another
plugin access still requires its own prompt. Enrollment changes can invalidate
keys, but do not promise immediate cancellation of an already issued system
authentication token or an operation already in progress.

Keys are never exported or cached as raw encryption key material in Native or
JavaScript. Biometric templates remain managed by Android. Business plaintext
does exist in JavaScript when supplied to `set` or returned by `get`, and in native
application memory during use. Keystore does not execute application business
logic inside secure hardware. The plugin does not log secret values; the host
must also disable secret-bearing bridge and application diagnostics.

Ciphertext is stored in the application's `noBackupFilesDir`, local to this
installation. This is not a backup or cross-device recovery mechanism. Losing
the protected key can make a stored entry inaccessible.

A future iOS implementation can use a scope-owned `LAContext` with Keychain
items protected by `biometryCurrentSet` and
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`. No identical Android key policy
or timeout behavior is promised for iOS. Keychain may report an invalidated item
as missing, so the shared API cannot promise that every platform distinguishes
every invalidation from a missing entry.

## Clearing saved entries

`clear` deletes this plugin's records and pending files, and deletes owned keys
enumerated by Android Keystore, including orphan keys. It does not decrypt values
or clear other application storage. An empty vault succeeds. An observable file
or key deletion failure reports `IO_ERROR`; clearing can be partial and retried.
It does not erase plaintext previously returned to the app or prevent later
writes. Finish the current credential flow before clearing.

Routine write cleanup makes a best effort to remove pending files and unused
keys. These cleanup failures do not change an already committed write into a
failure and are not reported by scope disposal. A later `clear` also attempts to
remove these orphaned resources.

From the app's WebView Console:

```js
await window.Capacitor.Plugins.BiometricVault.clear();
```

Application code can also call `await monoidCredentialsStore.clear()`.

The public Android Keystore provider can hide alias-enumeration failures as an
empty or partial result. The plugin propagates exposed errors but cannot certify
that no orphan key remains after an unreported provider failure. Ciphertext
deletion uses the plugin's own file list.

This API replaces per-operation authentication. Existing keys cannot have their
authentication policy changed in place. No migration or legacy key fallback is
implemented; development installations using the previous policy must explicitly
clear their old vault before saving entries with this version.

## Application integration

Validate retrieved text against the application's schema and keep cancellation,
unavailability, invalidation and corruption distinct from a missing value. Own
access alongside the relevant page or business flow and release it when that
owner ends. Keep application PIN collections and card-specific logic outside
this generic plugin.

Saving credentials after a successful card operation can still fail or outlive
the authorization window. Report that save failure separately so it does not
hide the card operation's success or repeat that operation. The Monoid app reads
its Access PIN collection before scanning and saves changes after the card exit
animation, using the same access. Safe PINs are not part of that collection.

## Errors

Rejections use `BiometricVaultErrorCode` and optional `data: {id?}`:
`UNSUPPORTED`, `BIOMETRIC_NOT_ENROLLED`, `BIOMETRIC_UNAVAILABLE`,
`BIOMETRIC_LOCKED_OUT`, `AUTHENTICATION_FAILED`, `HARDWARE_SECURITY_UNAVAILABLE`,
`ENTRY_INVALIDATED`, `DATA_CORRUPTED`, `IO_ERROR`, `INVALID_ARGUMENT`, `CANCELLED`,
`APP_INACTIVE`, `AUTHORIZATION_EXPIRED` and `ACCESS_CLOSED`.

## Verification

Local tests cover scope ownership, cancellation and commit ordering, queueing,
record integrity, atomic replacement and hardware-policy decisions. JVM and
mocked JavaScript tests do not exercise Android Keystore or biometric sensors.
Device validation is needed for actual protected reads/writes, enrollment
invalidation, expiry and activity lifecycle behavior.

From the repository root, using existing Node dependencies:

```sh
npm --prefix plugins/biometric-vault run check
npm --prefix plugins/biometric-vault run build
npm --prefix plugins/biometric-vault run lint
node --test tests/biometric-vault-access.test.mjs
```

The build writes JavaScript and declarations to ignored `dist/esm/`. It does not
install the app or run Capacitor sync. For standalone Android checks, use JDK 21
and an Android SDK with API 35 installed:

```powershell
.\android\gradlew.bat -p plugins/biometric-vault/android testDebugUnitTest assembleDebug lintDebug --console=plain
```

If Gradle on Windows cannot create its loopback socket, create a short directory
such as `C:/Temp/biometric-vault-sockets` and add
`-Djdk.net.unixdomain.tmpdir=C:/Temp/biometric-vault-sockets` to `JAVA_TOOL_OPTIONS`
for that shell.
