# capacitor-isodep-nfc

Private Capacitor 8 plugin for ISO-DEP APDU communication on Android API 24+ and
iOS 15+, used by the Monoid application through a local package dependency.
There is no web implementation. iOS simulator builds expose the plugin but
report NFC as unsupported.

The native plugin is registered as `IsoDepNfc`. APDU encoding, status words, applet
selection, authentication, response chaining and retry decisions belong to the
caller. The plugin does not interpret status words, reconnect, retry commands,
or expose NFC-V/NDEF operations. iOS validates the encoded command with
`NFCISO7816APDU(data:)` because Core NFC accepts ISO 7816 commands rather than
arbitrary ISO-DEP bytes.

## API

Import `IsoDepNfc` and the exported types from `capacitor-isodep-nfc` after adding
this local package to an application.

| Method                                                 | Result                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `getStatus()`                                          | `{supported, enabled}`                                       |
| `openSettings()`                                       | Opens Android NFC settings; iOS rejects `UNSUPPORTED`        |
| `startScan({scanId, transceiveTimeoutMs?})`            | Enables continuous scanning without waiting for a tag        |
| `stopScan({scanId})`                                   | Stops the scan, cancels its pending work and awaits cleanup  |
| `transceive({sessionId, data, timeoutMs?})`            | `{data}` with the unmodified response bytes                  |
| `setSessionMessage({sessionId, message})`              | Updates the iOS system sheet; Android rejects `UNSUPPORTED`  |
| `closeSession({sessionId, waitForRemoval?, message?})` | Closes one connection; optionally waits for detected removal |

## iOS integration and differences

The Swift Package Manager product is `CapacitorIsodepNfc`. A CocoaPods spec is
also included. The host app needs the `TAG` value in
`com.apple.developer.nfc.readersession.formats`, a nonempty
`NFCReaderUsageDescription`, and the complete supported AID list in the
`com.apple.developer.nfc.readersession.iso7816.select-identifiers` Info.plist key.
Enable Near Field Communication Tag Reading on the app's signed device profile.

Core NFC automatically selects the first matching AID in that list before the
plugin receives the tag. The app may still send its own SELECT to establish its
protocol state. Cards with no matching AID are not delivered to the app; include
the card manager AIDs if the app installs applets onto otherwise blank cards.
Subsequent SELECT-by-name commands are also checked against this list. Apple
does not allow payment AIDs in this reader API. The actual target cards, including
their GlobalPlatform manager AIDs, must be checked on an entitled physical
iPhone; a simulator cannot establish their acceptance. See Apple's
[ISO 7816 tag documentation](https://developer.apple.com/documentation/corenfc/nfciso7816tag)
and [reader session documentation](https://developer.apple.com/documentation/corenfc/nfctagreadersession).

`startScan` resolves when the reader becomes active and presents Apple's system
NFC sheet. This sheet covers the web UI. Stop the scan and await `stopScan` before
asking for a PIN or presenting biometrics; initiate another scan after the user
finishes. The plugin never silently restarts a cancelled or timed-out reader.
`getStatus` reports `readingAvailable` for both `supported` and `enabled`; iOS has
no user-facing NFC switch or dedicated NFC settings screen.

`setSessionMessage` updates the system sheet's
[`alertMessage`](https://developer.apple.com/documentation/corenfc/nfcreadersessionprotocol/alertmessage)
for the current connected session, including during an APDU exchange. Pass a
nonblank string; invalid text rejects `INVALID_ARGUMENT`. Updates for unknown,
closed or ended sessions, or while waiting for removal, reject `SESSION_CLOSED`
without replacing the current message. Text changes do not send commands,
restart polling or extend deadlines. Core NFC exposes no public spinner or
progress-bar control; callers can show actual operation stages or measured
progress in this text. Android rejects this iOS-only method with `UNSUPPORTED`.

On iOS, `closeSession` accepts an optional nonblank `message` to replace progress
with final text such as `Completed.` while closing a healthy, idle connection.
The update and close happen together, so late progress cannot overwrite the
final text. Only supply completion text after the application operation succeeds.
It is ignored for ended or unknown sessions, an ended scan, connection or APDU
work still in flight, a scan that has lost a connection, or any removal wait;
failure and removal feedback remain intact. Invalid text rejects
`INVALID_ARGUMENT`. Android ignores this option. The message does not change
cleanup, send an APDU, or stop the scan; await `stopScan` as usual.

The platform imposes its own reader-session time limit, normally 60 seconds.
Longer `transceiveTimeoutMs` values cannot extend it. A system timeout emits
`scanEnded` with `reason: 'timeout'` and `code: 'TIMEOUT'`; the open connection
ends with `scan-timeout`. User cancellation emits `scanEnded` with
`reason: 'cancelled'` and `code: 'CANCELLED'`. Going into the background ends the
reader with `app-paused` / `APP_INACTIVE`. Transient inactivity caused by native
UI does not itself terminate the reader.
Reloading the WebView revokes the old reader and drops its pending replies;
new-document calls still wait for native cleanup before opening another reader.

`stopScan` waits for Core NFC's invalidation callback, which is the transport
cleanup barrier. Core NFC exposes no separate sheet-animation completion
callback. Closing an idle connection normally calls `restartPolling`, invalidating
the old tag and allowing discovery in the same system sheet. If a command or
connect is still in flight, closing it or reaching the plugin deadline must
invalidate the entire reader; Core NFC cannot cancel one operation independently.
New commands remain blocked until invalidation completes. No command is retried.

`waitForRemoval` logically closes the connection to the caller but keeps its
native RF connection while observing `isAvailable` every 250 ms. The gate opens
only when the connected tag is unavailable while the reader is still ready, or
the transport has already reported `TAG_LOST`. Then polling restarts. This does
not send presence-check APDUs; it also does not deselect the applet or clear its
authentication until the RF link ends. A failed connection cannot establish
availability, so a removal wait after such a failure rejects `UNSUPPORTED` and
ends the scan. Cancellation, backgrounding and timeouts reject pending removal
waits instead of reporting successful removal. As with Android, this is a native
RF availability signal rather than proof of physical movement.

During an APDU exchange, Core NFC response/retry errors also map to `TAG_LOST`
when the connected tag is unavailable and the reader remains ready. An available
tag's response error remains `IO_ERROR`; reader invalidation and other explicit
errors keep their original classification. The failed APDU's outcome remains
`unknown`, and the plugin does not retry it.
When the caller stops that scan, Core NFC displays its error indicator with
"Card connection lost." instead of a success checkmark. The loss is retained
through connection cleanup and rediscovery until that scan ends. Successfully
waiting for card removal does not mark an operation as failed; normal completion,
system cancellation and timeouts retain their existing presentation.

Core NFC reports response data and SW1/SW2 separately; the plugin returns them
concatenated in the same `data` array as Android, including unsuccessful status
words. It does not consume GET RESPONSE, change the caller's command framing or
interpret authentication. Neither the maximum transport length nor hardware
extended-APDU support is exposed by Core NFC, so the optional
`maxTransceiveLength` and `adapterSupportsExtendedLengthApdu` metadata are omitted
on iOS. `NFCISO7816APDU(data:)` accepts valid short and extended APDUs, but card
and reader limits still apply.

## Android session behavior

`scanId` is a nonblank caller-generated string. Use a fresh ID for each scan. Only
one scan and one connecting or connected session can exist at a time. Each newly
discovered ISO-DEP tag is connected automatically, with a fixed 30-second
connection deadline. Scanning itself has no idle timeout. A successful connection
emits `sessionOpened` with a native-generated `sessionId`. Tags discovered while
a session or its cleanup is in progress are discarded, not queued for later.

Closing a session leaves scanning active. Without `waitForRemoval`, another
session requires only a new tag discovery; there is no UID filtering or
deduplication. Discovery is not proof of physical movement, RF power loss or a
card state reset. A failed connection or exchange closes its transport but keeps
discovery reserved until the caller explicitly calls `closeSession`, choosing
cleanup alone or waiting for removal. This also applies to connection failures
that emitted `sessionEnded` without `sessionOpened`.

`closeSession({sessionId, waitForRemoval: true})` first closes the connection and
finishes pending transport work, then waits for Android's
`NfcAdapter.OnTagRemovedListener` before accepting another session. Repeated
discoveries during this wait are discarded. The returned Promise resolves only
after the removal callback or an already detected `TAG_LOST`, and cleanup has
completed. A normal `sessionEnded` event means the transport ended, not that the
card left the field. Removing an idle, open card is not monitored until the caller
requests this close mode.

Reader Mode allows Android's discovery-time NDEF probe. In AOSP,
`FLAG_READER_SKIP_NDEF_CHECK` also bypasses the rediscovery debounce used by
`ignore`, so that flag cannot be combined with this removal wait. The probe
finishes before `sessionOpened`; the caller still selects its applet explicitly.

Stopping the scan cancels pending removal waits with `CANCELLED`. NFC disable,
activity pause and destruction reject them with the corresponding lifecycle
error instead of reporting removal. There is no idle timeout or automatic retry.
API 23 rejects this mode with `UNSUPPORTED`. If Android cannot register removal
detection (`ignore` returns false), it rejects with `IO_ERROR` and stops the scan;
this can also happen if the card has already left, but is not assumed to prove
removal. Waiting on an unknown session or one released by a normal close rejects
with `SESSION_CLOSED`. Repeating the wait for the last confirmed removed session
in the same active scan succeeds.

Ordinary `closeSession` succeeds for unknown or ended IDs and never closes a
different session. `stopScan` is also idempotent and never stops a different scan: even an
unknown ID is retired until the plugin reloads, preventing a late `startScan` for
that ID. Reusing an ended scan ID rejects with `SCAN_CLOSED`. Await `stopScan`
before starting a new scan. Starting while another scan or its cleanup is active
rejects with `BUSY`.
Both methods wait for native connection closure and previous work to exit.
Disabling NFC, pausing or destroying the host activity stops the scan. Returning
to the foreground or enabling NFC does not automatically restart it.

When the activity is still in the foreground, `stopScan` completes all transport
cleanup before returning tag discovery to Android. On Android 7 / API 24 and
later, it first calls
[`NfcAdapter.ignore`](<https://developer.android.com/reference/android/nfc/NfcAdapter#ignore(android.nfc.Tag,int,android.nfc.NfcAdapter.OnTagRemovedListener,android.os.Handler)>)
for the latest discovered tag, then disables Reader Mode. The tag is retained
after `closeSession` so this also covers closing the connection before stopping
the scan. The 1,000 ms debounce is the minimum time out of range before normal
system dispatch resumes; it is not a fixed delay added to `stopScan`.

This requests suppression of the system NFC chooser for a card left in place.
Android can reject the request when the tag is already gone or unavailable;
Logcat's `IsoDepNfc` entry records whether the request was accepted without
logging tag identifiers or payloads. API 23 has no `ignore` support. Android's
documented RF and random-UID limitations still apply, and activity pause can
disable Reader Mode independently of plugin cleanup.

The explicit removal wait uses the same 1,000 ms debounce with a callback while
Reader Mode remains enabled. Android may also report removal when a different
tag enters the field. This supplies an application-level rescan gate, subject to
Android's documented RF and random-UID limitations; it is not an absolute
physical-movement guarantee.

Byte arrays must be nonempty arrays of integers from 0 to 255. Concurrent
exchanges reject with `BUSY` and are not queued. `transceiveTimeoutMs` defaults to
10,000 ms; `timeoutMs` overrides it for one exchange. Timeout values must be
positive integers no greater than 2,147,483,647; 240,000 ms is valid for a long
operation. Platform NFC failures may still end an exchange earlier.

Tag `identifier` is optional metadata, not an authenticated card identity.
`maxTransceiveLength` and `adapterSupportsExtendedLengthApdu` describe the Android
adapter; they do not prove the card's command size or APDU support.

## Usage

Register all three lifecycle listeners before starting the scan. This example
performs one raw exchange per connection until the caller resolves
`stopRequested` or native scanning ends. It returns the native `scanEnded` event
when that ends the wait; inspect its reason and code. Connection failures are
reported through `sessionEnded`; exchange failures through their rejected
Promise, without reporting the same failure twice.

```ts
import type {PluginListenerHandle} from '@capacitor/core';
import {IsoDepNfc, type ScanEndedEvent} from 'capacitor-isodep-nfc';

async function scan(
  data: number[],
  stopRequested: Promise<void>,
  onResponse: (data: number[]) => void,
  onError: (error: unknown) => void,
): Promise<ScanEndedEvent | void> {
  const scanId = crypto.randomUUID();
  const listeners: PluginListenerHandle[] = [];
  const openedSessions = new Set<string>();
  let finishScan!: (event: ScanEndedEvent) => void;
  const nativeScanEnded = new Promise<ScanEndedEvent>(resolve => {
    finishScan = resolve;
  });

  try {
    listeners.push(
      await IsoDepNfc.addListener('sessionOpened', event => {
        if (event.scanId !== scanId) return;
        const {sessionId} = event;
        openedSessions.add(sessionId);
        void (async () => {
          try {
            const response = await IsoDepNfc.transceive({sessionId, data});
            onResponse(response.data);
          } finally {
            await IsoDepNfc.closeSession({sessionId});
          }
        })().catch(onError);
      }),
    );
    listeners.push(
      await IsoDepNfc.addListener('sessionEnded', event => {
        if (event.scanId !== scanId) return;
        const wasOpened = openedSessions.delete(event.sessionId);
        if (!wasOpened) {
          if (event.code) onError(event);
          void IsoDepNfc.closeSession({sessionId: event.sessionId}).catch(
            onError,
          );
        }
      }),
    );
    listeners.push(
      await IsoDepNfc.addListener('scanEnded', event => {
        if (event.scanId === scanId) finishScan(event);
      }),
    );
    await IsoDepNfc.startScan({scanId});
    return await Promise.race([stopRequested, nativeScanEnded]);
  } finally {
    try {
      await IsoDepNfc.stopScan({scanId});
    } finally {
      await Promise.all(listeners.map(listener => listener.remove()));
    }
  }
}
```

## Events and failures

`getStatus()` provides the initial adapter state. Match event IDs to the scan or
session being handled. Removing listeners does not stop scanning or close a
session.

| Event           | Payload                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `statusChanged` | `{supported, enabled}`                                                                            |
| `sessionOpened` | `{scanId, sessionId, tag: {identifier?, maxTransceiveLength, adapterSupportsExtendedLengthApdu}}` |
| `sessionEnded`  | `{scanId, sessionId, reason, code?}`                                                              |
| `scanEnded`     | `{scanId, reason, code?}`                                                                         |

Session end reasons are `closed`, `connect-timeout`, `transceive-timeout`, `scan-timeout`,
`tag-lost`, `io-error`, `scan-stopped`, `nfc-disabled`, `app-paused` and `destroyed`.
Scan end reasons are `stopped`, `nfc-disabled`, `app-paused`, `destroyed` and
`io-error`, plus `cancelled` and `timeout` on iOS. Failures include an `IsoDepNfcErrorCode`; normal `closed`,
`scan-stopped` and `stopped` events omit it. A failed connection also emits
`sessionEnded`, even though it never emitted `sessionOpened`. An end event marks
its ID invalid while cleanup may still be running; await `closeSession` or
`stopScan` for the corresponding cleanup to finish. A failure to close the native
transport stops the scan with `io-error` / `IO_ERROR`.

Native rejections have a `code` from `IsoDepNfcErrorCode` and optional `data`:

```ts
type IsoDepNfcErrorData = {
  scanId?: string;
  sessionId?: string;
  operation?: 'startScan' | 'transceive';
  outcome?: 'not-sent' | 'unknown';
};
```

The codes are `UNSUPPORTED`, `NFC_DISABLED`, `APP_INACTIVE`, `BUSY`,
`INVALID_ARGUMENT`, `SCAN_CLOSED`, `SESSION_CLOSED`, `CANCELLED`, `TIMEOUT`,
`TAG_LOST`, `IO_ERROR` and `DATA_TOO_LARGE`.

The plugin's own deadline reports `TIMEOUT`. Android may instead report a plain
`IOException`, which becomes `IO_ERROR`; it cannot always be identified as a
timeout. Neither case triggers an automatic retry.

For a failed exchange, `not-sent` means the native send operation was not invoked.
Once invoked, a failure reports `unknown`: the card might have executed the
command even if the response was lost. Cancellation and timeout do not roll back
card operations. Let the protocol decide whether another attempt is valid.

The plugin does not log APDU payloads. Capacitor's debug bridge can log
`call.data`; production integration must also configure the host's
`loggingBehavior` appropriately.

## Verification

Use the repository's existing Node dependencies; no separate install is needed.
From the repository root:

```sh
npm --prefix plugins/isodep-nfc run check
npm --prefix plugins/isodep-nfc run build
npm --prefix plugins/isodep-nfc run lint
```

The build writes JavaScript and declarations to the ignored `dist/esm/` directory.
Building this package does not install it into the application or run Capacitor
sync.

For the standalone Android build, use JDK 21 and set `ANDROID_HOME` to an Android
SDK with API 36 installed. From the repository root in PowerShell:

```powershell
.\android\gradlew.bat -p plugins/isodep-nfc/android testDebugUnitTest assembleDebug lintDebug --console=plain
```

If Gradle on Windows fails to create its loopback socket, create a short temporary
directory such as `C:/Temp/isodep-sockets` and add
`-Djdk.net.unixdomain.tmpdir=C:/Temp/isodep-sockets` to `JAVA_TOOL_OPTIONS` for that
shell.

On macOS, build the iOS plugin and run its native lifecycle tests from this
package directory. Choose an available simulator from `xcrun simctl list devices`:

```sh
xcodebuild -scheme CapacitorIsodepNfc \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/monoid-nfc-derived-data CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme CapacitorIsodepNfc \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UUID' \
  -derivedDataPath /tmp/monoid-nfc-derived-data CODE_SIGNING_ALLOWED=NO test
```

These tests exercise serialized exchanges, cancellation and timeout races, stale
native callbacks, removal gating, scan-ID retirement and strict JS argument
validation with injected readers and clocks. Real NFC field loss, firmware
operations and signing entitlements still require an iPhone and target card.
