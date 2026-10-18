# monoid-app

Just another awesome magic.

## Local development

Use Node.js 22.12 or newer (`.nvmrc` pins the tested Node 22 version), then install
the locked dependencies:

```sh
npm ci
npm run dev
```

`npm run build` checks and compiles TypeScript. `npm run build:web` also builds the
Vite app into `dist`, which Capacitor copies into the native projects.

## iOS development

Install Xcode 26 or newer with the iOS platform and an iPhone simulator. Open
Xcode once to finish its initial setup, then select its developer tools:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun simctl list devices available
```

The iOS project uses Swift Package Manager, so CocoaPods is not required. Its
Capacitor iOS version matches the app's CLI, core and Android version, 8.5.3. The
deployment target is iOS 15 or newer. The app uses the UIScene lifecycle required
by Xcode 27.

If no iPhone simulator is available after installing Xcode, download the iOS
runtime in Xcode > Settings > Components, or run:

```sh
xcodebuild -downloadPlatform iOS
```

```sh
npm run ios:sync
npm run ios:open
```

In Xcode, select the `App` scheme and an iPhone simulator, then run. Xcode 27 shows
simulators in Device Hub (Xcode > Open Developer Tool > Device Hub). For a physical
iPhone, choose your signing team under Signing & Capabilities and enable Developer
Mode on the device. `npm run ios` builds and syncs the web app, then opens Xcode.
Use Xcode to launch the simulator: Capacitor's current `native-run` dependency
still expects the older `Simulator.app` path.

The local plugins implement NFC with Core NFC, credential storage with Keychain
and Face ID/Touch ID, and QR scanning with AVFoundation. Both QR entry points use
the native camera. The project includes NFC tag-reading entitlements, the bundled
applet and card-manager AIDs, and NFC, camera and Face ID usage descriptions.

Core NFC presents a system sheet with a limited session lifetime. Credentials are
unlocked before scanning; manual PIN entry and credential saving wait until the
reader closes. On iOS, card errors close the sheet and return to the caller so the
message remains visible; start the action again to retry. Updating bundled applet
AIDs also requires updating `Info.plist`.

The vault requires enrolled biometrics and a device passcode. Each explicit access
scope authenticates once and lasts at most 60 seconds; backgrounding or closing it
revokes access. Keychain items stay on this device and are bound to the current
biometric enrollment. Missing or invalidated credentials fall back to manual PIN
entry. See the [vault details](plugins/biometric-vault/README.md).

Simulator builds cover app startup, bridge registration and native unit tests.
NFC requires a physical iPhone and a signing profile with NFC Tag Reading enabled.
Before shipping, verify card installation and signing, Face ID/Touch ID enrollment
changes, and camera permission/cropping/rotation on device. Core NFC timeouts must
not trigger an automatic replay of a card mutation.

Run application regression tests after compiling:

```sh
npm run build
node --experimental-test-module-mocks --test tests/*.test.mjs
```

Each native plugin is also an independent Swift package with an XCTest target.
Run its tests from Xcode or `xcodebuild test` with an available iPhone simulator;
see the plugin READMEs for the package schemes.

See the [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup),
[Swift Package Manager setup](https://capacitorjs.com/docs/ios/spm) and
[UIScene migration guide](https://capacitorjs.com/docs/updating/8-5).

## Android development

Capacitor 8 uses JDK 21, Android SDK 36, Android Gradle Plugin 8.13 and Gradle
8.14.3. The app's minimum Android version is API 24. Use Android Studio Otter
2025.2.1 or newer, or install the equivalent command-line SDK tools.

The local keyboard plugin retains Monoid's `keyboardHeightChanged` event.
`SystemBars.insetsHandling` is disabled because the app already handles safe areas
and keyboard insets in its layout.

## Development services

- [Gas history Worker](workers/gas-history/README.md): Ethereum base-fee sampling,
  Cloudflare configuration, and the APP's `VITE_GAS_HISTORY_URL` setting.

## Research

- [Security Key 签名算法支持顺序](research/security-key/README.md)
- [多链签名解析与交易结果模拟](research/signing-payload-parsing/README.md)

## Design

- [地址管理与卡片同步](docs/address-management.md)

## License

MIT License.
