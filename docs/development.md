# Development

## Setup

Use Node.js 22.12 or newer (`.nvmrc` pins the tested version), then install the
locked dependencies. Installing also builds the local Capacitor plugins.

```sh
npm install
npm run dev
```

`npm run dev` serves the app in a browser for UI work; card features need a
phone with NFC.

| Command                   | What it does                                            |
| ------------------------- | ------------------------------------------------------- |
| `npm run build`           | Type-check and compile TypeScript into `.bld`           |
| `npm run build:web`       | Prepare applets, compile, then build the web app        |
| `npm test`                | Prettier, compile, ESLint and the application tests     |
| `npm run test:app`        | Application tests only (run `npm run build` first)      |
| `npm run android`         | Run on an Android device with live reload               |
| `npm run ios`             | Build, sync and open the iOS project in Xcode           |
| `npm run prepare:applets` | Refresh the bundled card applets from `monoid-javacard` |

## Configuration

Vite reads `.env` and `.env.development`:

| Variable                                         | Purpose                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `VITE_WALLETCONNECT_PROJECT_ID`                  | Reown (WalletConnect) Cloud project ID. Forks should use their own.              |
| `VITE_GAS_HISTORY_URL`                           | [Gas history Worker](../workers/gas-history/README.md) for Ethereum fee history. |
| `VITE_DEFAULT_INSTALLATION_AUTHORITY_URL`        | Authority suggested when installing applets (optional).                          |
| `VITE_DEFAULT_INSTALLATION_AUTHORITY_PUBLIC_KEY` | Its public key, if set together with the URL.                                    |

## Card applets

The app installs the Monoid applets from `src/@assets/applets`, generated from
[monoid-javacard](https://github.com/vilicvane/monoid-javacard), which owns the
card protocol. With that repository checked out next to this one and built
(`./gradlew buildJavaCard`), `npm run build:web`, `npm run android` and
`npm run ios:sync` copy its CAP files first; invalid CAPs stop the build. Without
the checkout, the build keeps the committed applets.

Commit refreshed applets together with the app changes that match them, or cards
installed by the app keep the old protocol.

## Android

Capacitor 8 uses JDK 21, Android SDK 36, Android Gradle Plugin 8.13 and Gradle
8.14.3. The minimum Android version is API 24. Use Android Studio Otter 2025.2.1
or newer, or the equivalent command-line tools.

`npm run android` uses Ionic live reload. It edits `AndroidManifest.xml` while it
runs and restores it on exit, so stop it before editing the manifest yourself.

## iOS

Install Xcode 26 or newer with the iOS platform and an iPhone simulator, open
Xcode once, then select its developer tools:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun simctl list devices available
```

If no simulator is listed, download the iOS runtime in Xcode > Settings >
Components, or run `xcodebuild -downloadPlatform iOS`.

The project uses Swift Package Manager (no CocoaPods), Capacitor 8.5.3, iOS 15 or
newer and the UIScene lifecycle.

```sh
npm run ios:sync
npm run ios:open
```

In Xcode, select the `App` scheme and run. For a physical iPhone, choose your
signing team under Signing & Capabilities and enable Developer Mode on the
device. NFC needs a physical iPhone and a signing profile with NFC Tag Reading.
Launch simulators from Xcode: Capacitor's `native-run` still expects the older
`Simulator.app` path. Updating bundled applet AIDs also requires updating
`Info.plist`.

See the [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup),
[Swift Package Manager](https://capacitorjs.com/docs/ios/spm) and
[UIScene migration](https://capacitorjs.com/docs/updating/8-5) guides.

## Native plugins

| Plugin                                                  | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| [isodep-nfc](../plugins/isodep-nfc/README.md)           | ISO-DEP card sessions (Android Reader Mode, iOS Core NFC)   |
| [biometric-vault](../plugins/biometric-vault/README.md) | Remembered Access PINs, unlocked with biometrics            |
| [qr-scanner](../plugins/qr-scanner/README.md)           | Native camera QR scanning                                   |
| [keyboard](../plugins/keyboard/README.md)               | Vendored `@capacitor/keyboard` with a keyboard height event |

The vault requires enrolled biometrics and a device passcode. Each explicit
access lasts at most 60 seconds and ends when the app goes to the background;
missing or invalidated credentials fall back to typing the PIN.

## Testing

Application tests run against the compiled output:

```sh
npm run build
npm run test:app
```

Each native plugin also has its own tests: Android unit tests through Gradle
(for example `./gradlew :capacitor-isodep-nfc:testDebugUnitTest` from `android`)
and an XCTest target per Swift package (see the plugin READMEs).

Simulators cover startup, bridge registration and native unit tests. Before a
release, check on real devices: card installation and signing, biometric
enrollment changes, and camera permission and recovery. A Core NFC timeout must
never replay a card write.

### iPhone UI tests

The shared `MonoidUITests` scheme checks camera authorization and foreground
recovery on a physical iPhone:

```sh
npm run ios:sync
xcrun devicectl list devices
xcodebuild test -project ios/App/App.xcodeproj -scheme MonoidUITests \
  -destination 'platform=iOS,id=DEVICE_UDID' \
  -allowProvisioningUpdates -parallel-testing-enabled NO
```

The tests reset only Monoid's camera permission, keep app data, and skip on
simulators. The Bitcoin popup test needs an existing wallet with a spendable
balance and never sends a transaction.

## Workers

- [Authority](../workers/authority/README.md): the optional Monoid Authority
  service (bundle enrollment and signed time proofs) on Cloudflare Workers.
- [Gas history](../workers/gas-history/README.md): Ethereum base-fee history for
  fee suggestions.
