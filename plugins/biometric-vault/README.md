# capacitor-biometric-vault

Private Capacitor 7 plugin for storing small secret text values. The first
implementation targets Android API 23+ and registers as `BiometricVault`. Monoid's
Credentials Store uses it for saved Access PINs. There is no web or iOS implementation.

## API

Import `BiometricVault` and its types from `capacitor-biometric-vault` after
adding this local package to an application.

| Method                                | Result                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `getAvailability()`                   | `{biometrics: 'available' \| 'not-enrolled' \| 'unavailable' \| 'unsupported' \| 'unknown'}` |
| `set({id, value, requestId, reason})` | Stores or replaces a protected text value; Android authenticates each write                  |
| `get({id, requestId, reason})`        | `{value: string \| null}`; `null` means no stored entry                                      |
| `remove({id})`                        | Deletes an entry without authentication; missing entries succeed                             |
| `clear()`                             | Deletes all vault entries and cleans up their keys without authentication                    |
| `cancel({requestId})`                 | Cancels or pre-cancels that request ID                                                       |

`id`, `requestId` and `reason` must be nonblank; their whitespace is preserved.
IDs are limited to 512 UTF-8 bytes, request IDs to 128 characters and reasons to
256 characters. Values may be empty and are limited to 64 KiB in UTF-8. Strings
must contain valid Unicode, without unpaired UTF-16 surrogates. The application
supplies `reason`; the plugin presents the native biometric prompt.

Every accepted `set` and `get` needs a fresh caller-generated `requestId`,
including retries. IDs are single-use for the plugin instance, including
pre-cancelled IDs; reuse rejects with `CANCELLED`. `set`, `get`, `remove` and
`clear` execute in call order. Each operation waits for the previous operation's
authentication, storage work and cleanup to finish. A queued `set` or `get`
already owns its request ID and can be cancelled before it starts.

New operations require the app to be in the foreground. Backgrounding or
destroying the activity rejects queued operations with `APP_INACTIVE` and cancels
active authentication. An already started `remove` or `clear` finishes normally.

Availability checks do not display a prompt. They describe strong biometric
availability, not whether an existing entry or a new hardware-protected key will
work. A missing entry returns `null` without an authentication prompt.
Authentication, key invalidation and storage failures reject; they are not
converted to missing values on Android.

```ts
import {BiometricVault} from 'capacitor-biometric-vault';

async function remember(id: string, value: string): Promise<void> {
  await BiometricVault.set({
    id,
    value,
    requestId: crypto.randomUUID(),
    reason: 'Save this secret on this device',
  });
}

async function read(id: string): Promise<string | null> {
  const {value} = await BiometricVault.get({
    id,
    requestId: crypto.randomUUID(),
    reason: 'Read the saved secret',
  });
  return value;
}
```

Keep the request ID to call `cancel` when its owner no longer needs the result.
Cancellation is idempotent and affects only that request; awaiting `cancel` does
not wait for the original request to settle. Cancellation before a write's atomic
commit preserves the previous value. Once committed, the write succeeds even if
cancellation arrives before its JavaScript result. A following storage operation
waits for the cancelled request's cleanup automatically.

Failed writes preserve the old record. A failed read never silently deletes or
replaces an entry. An explicit `set` can replace an invalidated or corrupted entry,
and `remove` can delete it without authentication.

`clear` deletes this plugin's records and pending files, and deletes its keys
enumerated by Android Keystore, including orphan keys left by interrupted or
corrupt records. It does not read or decrypt
values, and it does not clear other application storage. Clearing an empty vault
succeeds. A file or key deletion failure rejects with `IO_ERROR`; some entries
may already have been deleted, so the caller can retry. Clearing saved entries
does not revoke plaintext already returned to the app or prevent later writes.

The public Android Keystore provider can hide an alias-enumeration failure as
an empty or partial result ([AOSP implementation](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/keystore/java/android/security/keystore2/AndroidKeyStoreSpi.java#L1036-L1047)).
The plugin propagates errors exposed by the provider, but cannot certify that no
orphan keys remain after an unreported provider failure. Ciphertext deletion
uses the plugin's own file list.

After installing an Android build containing this method, the app's WebView
Console can clear the vault directly. Finish the current card flow first so a
later save from that flow does not recreate an entry:

```js
await window.Capacitor.Plugins.BiometricVault.clear();
```

Monoid application code can call `await monoidCredentialsStore.clear()`.

## Protection and platform boundaries

Android uses Android Keystore keys protected by secure hardware, with the user
authentication requirement enforced by that hardware. Each encryption or
decryption operation requires fresh strong biometric authentication bound to its
`CryptoObject`; authentication is not cached. Android API 28+ uses the system
biometric prompt; API 23–27 uses fingerprint authentication with a native dialog.
Device-credential fallback and software-only keys do not satisfy this policy.
A device that cannot provide the required protection rejects with
`HARDWARE_SECURITY_UNAVAILABLE`.

The plugin stores ciphertext in the application's `noBackupFilesDir`. These
entries are local to the installation and are not a backup or cross-device
recovery mechanism. Biometric enrollment or device security changes can invalidate
keys; reads report this instead of silently deleting data or generating a
replacement key.

Plaintext values exist in JavaScript when supplied to `set` or returned by `get`,
and in native application memory during use. Keystore protects the encryption
key; it does not execute the application's secret-consuming code in a TEE. The
plugin does not log secret values. Capacitor debug logging and application logs
can expose bridge data, so production integration must also configure the host's
`loggingBehavior` and remove secret-bearing diagnostics.

A future iOS implementation can map entries to generic-password Keychain items
with `biometryCurrentSet` and `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`.
It would use a fresh `LAContext` for each read. Adding a Keychain item does not
inherently require authentication, so write prompts can differ between platforms.
Keychain's system-managed data protection is different from exposing an
Android-style hardware AES key; the shared API describes protected values rather
than a particular cipher provider.
iOS can report an invalidated item as not found, so the shared API cannot promise
that every platform distinguishes every invalidation from a missing entry.

## Application integration

The application should validate retrieved text against its own data schema and
map a missing value to its existing missing-credential representation. Keep
`CANCELLED`, biometric unavailability and `ENTRY_INVALIDATED` distinct from a
missing entry; each needs an intentional recovery path.

Reads and writes may wait for user interaction. Decide whether the surrounding
operation can remain open during that wait, and associate each request ID with
its owner so navigation, session termination or other cleanup can cancel it.
Operations from other owners wait in the same native queue.

Saving a credential is a separate operation from the business action that made it
useful. Define how to report a save failure after that action succeeded, so it
does not hide the success or cause an accidental repeat. Existing plaintext
credentials require a separate migration and removal policy; integrating this
plugin does not remove them or redact application, protocol or bridge logs.

## Errors

Rejections use `BiometricVaultErrorCode` and optional `data: {id?, requestId?}`:
`UNSUPPORTED`, `BIOMETRIC_NOT_ENROLLED`, `BIOMETRIC_UNAVAILABLE`,
`BIOMETRIC_LOCKED_OUT`, `AUTHENTICATION_FAILED`, `HARDWARE_SECURITY_UNAVAILABLE`,
`ENTRY_INVALIDATED`, `DATA_CORRUPTED`, `IO_ERROR`, `INVALID_ARGUMENT`,
`CANCELLED` and `APP_INACTIVE`.

## Verification

Local JVM tests cover request ownership, cancellation and commit ordering, record
integrity, file replacement and hardware-policy decisions. They do not exercise
Android Keystore or a biometric sensor. Device validation is still required for
actual protected reads/writes, enrollment invalidation, cancellation followed by
retry, and activity backgrounding or recreation.

Use the repository's existing Node dependencies. From the repository root:

```sh
npm --prefix plugins/biometric-vault run check
npm --prefix plugins/biometric-vault run build
npm --prefix plugins/biometric-vault run lint
```

The build writes JavaScript and declarations to the ignored `dist/esm/` directory.
It does not install the package into the application or run Capacitor sync.

For standalone Android verification, use JDK 21 and set `ANDROID_HOME` to an
Android SDK with API 35 installed. From the repository root in PowerShell:

```powershell
.\android\gradlew.bat -p plugins/biometric-vault/android testDebugUnitTest assembleDebug lintDebug --console=plain
```

If Gradle on Windows cannot create its loopback socket, create a short temporary
directory such as `C:/Temp/biometric-vault-sockets` and add
`-Djdk.net.unixdomain.tmpdir=C:/Temp/biometric-vault-sockets` to `JAVA_TOOL_OPTIONS`
for that shell.
