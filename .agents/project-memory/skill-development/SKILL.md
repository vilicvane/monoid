---
name: project-memory-development
description: Monoid app development basics, sibling firmware, Capacitor iOS/Android tooling and validation. Use for code changes in this repo; for card or PIN work, also read project-memory-card-session.
---

# Monoid app development

Source: `../records.md`, records 13, 14, 25–33. Treat these records as authoritative and keep them up to date.

- The app (Ionic React + Capacitor, iOS and Android) drives the card applets of the sibling repo `monoid-javacard`, which owns the card protocol. The app mirrors its commands as x-value schemas in `src/@lib/monoid/monoid-applet.ts`, on top of the generic `CBORApplet`/`Applet` transport in `src/@lib`.
- The project is old: point out whenever the user's choices conflict with the interactions its existing code implies.
- When a wallet list is the main content of a page (including Transactions wallet selection), use the shared roomy layout by default. Embedded account summaries opt into `WalletAccountList`'s `compact` spacing; `compactContent` separately controls the gap between tags and address.
- Verify from the repo root with `npx tsc --build --pretty false` and `npx prettier --check <files>`.
- Run ESLint from `src`, e.g. `Push-Location src; npx eslint --report-unused-disable-directives '<path>'; Pop-Location`. From the root it fails with "TSConfig does not include this file". Quote `@`-prefixed paths in PowerShell.
- The old 14-error lint count is historical; compare actual changed files against the current baseline.
- Use Node 22.12+ and Capacitor 8.5.3. `npm run ios:sync` builds web assets and regenerates the iOS SPM dependencies; avoid hand-editing generated `CapApp-SPM`. `npm run ios` opens Xcode; Xcode 27 launches simulators through Device Hub.
- After `npm run build`, run application tests with `node --experimental-test-module-mocks --test tests/*.test.mjs`. The native plugin packages have independent XCTest targets; simulator checks do not establish NFC or Secure Enclave behavior. Core iOS decisions and remaining physical-device checks are in `../29.md`.
- The shared `MonoidUITests` scheme verifies first camera authorization on a real iPhone, resetting only Monoid's camera permission and preserving app data and other permissions. First authorization must wait for an actual app-activation notification after requesting access, because the reply can precede deactivation while activity snapshots still appear active.
