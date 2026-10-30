<h1 align="center">Monoid</h1>

<p align="center">
  <img src="resources/icon.png" alt="Monoid" width="96" />
</p>

<p align="center">
  Your keys on a card you can hold. Monoid is the Android and iOS app for
  <a href="https://github.com/vilicvane/monoid-javacard">Monoid JavaCard</a>:
  tap the card on your phone to sign, unlock and manage what it holds.
</p>

## Features

- **Safe**: create, import and organize seeds and keys on the card; derive
  Bitcoin, EVM and Solana addresses. Private keys never leave the card.
- **Wallets**: send and receive Bitcoin; view Ethereum and Solana activity.
- **WalletConnect**: connect to apps and sites and sign EVM and Solana requests
  with the card. With [monoid-ssh-agent](https://github.com/vilicvane/monoid-ssh-agent),
  sign SSH logins too.
- **Security Key**: use the card as a FIDO2 security key and manage its
  credentials.
- **OTP**: get one-time passwords (TOTP) from the card.
- **Multiple cards**: put cards in a bundle to back up and sync their contents,
  optionally with the [Monoid Authority](workers/authority/README.md) service.
- **Card Applets**: install and update the Monoid applets on a blank card.

## What you need

- An Android (7+) or iOS (15+) phone with NFC.
- A JavaCard 3.0.5 card with ECC support. See
  [cards](https://github.com/vilicvane/monoid-javacard/blob/master/doc/cards.md)
  for vendors; the app installs the applets for you.

Two PINs protect a card. The **Access PIN** covers everyday use, and the app can
remember it behind your phone's biometrics. The **Secret PIN** guards exports and
PIN changes, and is never stored.

## Build from source

With Node.js 22.12 or newer:

```sh
npm install
npm run dev       # browser preview, without NFC
npm run android   # Android device with live reload
npm run ios       # build and open the iOS project in Xcode
npm test          # formatting, types, lint and tests
```

See [development](docs/development.md) for platform setup, configuration, the
bundled card applets and testing.

## Repository

| Path        | Contents                                                      |
| ----------- | ------------------------------------------------------------- |
| `src/`      | The app (Ionic React, Capacitor, MobX)                        |
| `plugins/`  | Native Capacitor plugins for NFC, biometrics, QR and keyboard |
| `workers/`  | Cloudflare Workers: Authority and gas history                 |
| `tests/`    | Application tests                                             |
| `docs/`     | Development and design notes                                  |
| `research/` | Background research (Chinese)                                 |

## Related projects

- [monoid-javacard](https://github.com/vilicvane/monoid-javacard): the card
  applets and the card protocol.
- [monoid-ssh-agent](https://github.com/vilicvane/monoid-ssh-agent): an SSH agent
  that signs with the card through this app.

## Security

Please report vulnerabilities privately to support@monoid.app rather than in a
public issue.

## License

[MIT](LICENSE)
