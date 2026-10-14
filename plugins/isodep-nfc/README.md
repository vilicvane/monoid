# capacitor-isodep-nfc

Private Capacitor 7 plugin for raw ISO-DEP communication on Android, used by the
Monoid application through a local package dependency. There is no web or iOS
implementation.

The native plugin is registered as `IsoDepNfc`. APDU encoding, status words, applet
selection, authentication, response chaining and retry decisions belong to the
caller. The plugin does not parse APDUs, reconnect, retry commands, or expose
NFC-V/NDEF operations.

## API

Import `IsoDepNfc` and the exported types from `capacitor-isodep-nfc` after adding
this local package to an application.

| Method                                      | Result                                                       |
| ------------------------------------------- | ------------------------------------------------------------ |
| `getStatus()`                               | `{supported, enabled}`                                       |
| `openSettings()`                            | Opens Android NFC settings                                   |
| `startScan({scanId, transceiveTimeoutMs?})` | Enables continuous scanning without waiting for a tag        |
| `stopScan({scanId})`                        | Stops the scan, cancels its pending work and awaits cleanup  |
| `transceive({sessionId, data, timeoutMs?})` | `{data}` with the unmodified response bytes                  |
| `closeSession({sessionId})`                 | Closes one connection and awaits cleanup; scanning continues |

`scanId` is a nonblank caller-generated string. Use a fresh ID for each scan. Only
one scan and one connecting or connected session can exist at a time. Each newly
discovered ISO-DEP tag is connected automatically, with a fixed 30-second
connection deadline. Scanning itself has no idle timeout. A successful connection
emits `sessionOpened` with a native-generated `sessionId`. Tags discovered while
a session or its cleanup is in progress are discarded, not queued for later.

Closing a session leaves scanning active. Another session requires a new tag
discovery; there is no UID filtering or deduplication, so the same card can be
removed and presented again. Discovery is not proof of physical movement, RF
power loss or a card state reset. Removing an idle card does not produce an
immediate notification; a later exchange can detect the loss.

`closeSession` succeeds for unknown or ended IDs and never closes a different
session. `stopScan` is also idempotent and never stops a different scan: even an
unknown ID is retired until the plugin reloads, preventing a late `startScan` for
that ID. Reusing an ended scan ID rejects with `SCAN_CLOSED`. Await `stopScan`
before starting a new scan. Starting while another scan or its cleanup is active
rejects with `BUSY`.
Both methods wait for native connection closure and previous work to exit.
Disabling NFC, pausing or destroying the host activity stops the scan. Returning
to the foreground or enabling NFC does not automatically restart it.

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
        if (!wasOpened && event.code) onError(event);
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

Session end reasons are `closed`, `connect-timeout`, `transceive-timeout`,
`tag-lost`, `io-error`, `scan-stopped`, `nfc-disabled`, `app-paused` and `destroyed`.
Scan end reasons are `stopped`, `nfc-disabled`, `app-paused`, `destroyed` and
`io-error`. Failures include an `IsoDepNfcErrorCode`; normal `closed`,
`scan-stopped` and `stopped` events omit it. A failed connection also emits
`sessionEnded`, even though it never emitted `sessionOpened`. An end event marks
its ID invalid while cleanup may still be running; await `closeSession` or
`stopScan` for the corresponding cleanup to finish. A failure to close the native
transport stops the scan with `io-error` / `IO_ERROR`.

Android rejections have a `code` from `IsoDepNfcErrorCode` and optional `data`:

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

For a failed exchange, `not-sent` means native `IsoDep.transceive` was not invoked.
Once invoked, a failure reports `unknown`: the card might have executed the
command even if the response was lost. Cancellation and timeout do not roll back
card operations. Let the protocol decide whether another attempt is valid.

The plugin does not log APDU payloads. Capacitor 7's debug bridge can log
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
SDK with API 35 installed. From the repository root in PowerShell:

```powershell
.\android\gradlew.bat -p plugins/isodep-nfc/android testDebugUnitTest assembleDebug lintDebug --console=plain
```

If Gradle on Windows fails to create its loopback socket, create a short temporary
directory such as `C:/Temp/isodep-sockets` and add
`-Djdk.net.unixdomain.tmpdir=C:/Temp/isodep-sockets` to `JAVA_TOOL_OPTIONS` for that
shell.
