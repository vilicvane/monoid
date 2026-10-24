# capacitor-cloud-kv

Private Capacitor 8 plugin for small string values that should survive moving
to a new phone. The plugin registers as `CloudKV`; application schemas stay
outside it.

| Platform | Storage                                     | Reaches other devices                                                                         |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| iOS 15+  | `NSUbiquitousKeyValueStore` (iCloud)        | Live, on devices signed in to the same Apple Account; `change` events report incoming updates |
| Android  | SharedPreferences `app.monoid.cloud-kv`     | Only through Android Auto Backup restore on a device with the same Google account             |
| Web      | `localStorage`, prefixed `monoid.cloud-kv:` | Never; for development only                                                                   |

## API

```ts
import {CloudKV} from 'capacitor-cloud-kv';

await CloudKV.set({key: 'example/a', value: JSON.stringify(record)});
const {value} = await CloudKV.get({key: 'example/a'});
const {entries} = await CloudKV.list({prefix: 'example/'});

const handle = await CloudKV.addListener('change', ({reason, keys}) => {
  // Reload `keys`; reload everything for 'account-change'.
});
```

| Method                      | Result                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `getInfo()`                 | `{backend: 'icloud' \| 'android-backup' \| 'web', liveSync: boolean}`   |
| `get({key})`                | `{value: string \| null}`; `null` means a missing key                   |
| `set({key, value})`         | Stores or replaces a value; rejects with `QUOTA_EXCEEDED` without write |
| `remove({key})`             | Deletes a key; missing keys are ignored                                 |
| `list({prefix?})`           | `{entries: {key, value}[]}` sorted by key                               |
| `synchronize()`             | Asks iOS to exchange pending changes soon; no-op elsewhere              |
| `addListener('change', fn)` | iOS only: `{reason, keys}` after another device or iCloud changes data  |

Every platform applies iCloud's limits: keys are nonempty and at most 64 UTF-8
bytes; at most 1024 keys; keys plus values total at most 1,000,000 UTF-8 bytes.
Strings with unpaired UTF-16 surrogates are rejected. Errors carry `code`:
`INVALID_ARGUMENT`, `QUOTA_EXCEEDED` or `IO_ERROR`.

## Consistency

iCloud resolves conflicts per key: the last write wins, and a removal on one
device removes the key everywhere. Store independent records under separate keys
so concurrent additions on different devices merge. A `set` that resolves has
been stored locally; upload happens later and is not acknowledged.

`change` reasons:

- `server`: another device changed `keys`.
- `initial-sync`: the first download after installation or sign-in.
- `quota-violation`: iCloud rejected the store size; trim data.
- `account-change`: the Apple Account changed and the store now holds the other
  account's data; reload every key.

Events are retained until the first listener subscribes, so the initial sync is
not lost during startup.

Without an iCloud account (or with iCloud disabled for the app) iOS keeps values
on the device only; `getInfo` cannot detect this.

## Setup

iOS: the app needs the iCloud key-value storage entitlement:

```xml
<key>com.apple.developer.ubiquity-kvstore-identifier</key>
<string>$(TeamIdentifierPrefix)$(CFBundleIdentifier)</string>
```

The App ID must have the iCloud capability; Xcode automatic signing adds it.
Simulators sync only when signed in to iCloud.

Android: the app keeps `android:allowBackup="true"`. If it later adds
`android:fullBackupContent` or `android:dataExtractionRules`, include
`sharedpref/app.monoid.cloud-kv.xml` in both cloud backup and device transfer.
Auto Backup runs roughly daily when the device is idle, charging and on Wi-Fi,
and requires Google Play services and the user's backup setting. To test,
`adb shell bmgr backupnow app.monoid`, uninstall, reinstall.

## Tests

- JavaScript wrapper: `tests/cloud-kv.test.mjs` in the app.
- Android: `CloudKVStoreTest` (JUnit) from Android Studio or Gradle.
- iOS: scheme `CloudKVPluginTests` (XCTest) with an iPhone simulator.

The unit tests cover limits and listing over in-memory backends. Real iCloud
propagation and Android backup restore need physical devices.
