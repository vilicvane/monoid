---
name: project-memory-development
description: Monoid app development basics. Covers how the app relates to the `monoid-javacard` firmware repo, how to type-check, lint and format on Windows, the current lint baseline, and how to work with the user on this old codebase. Use for any code change in this repo; for card or PIN work, also read `project-memory-card-session`.
---

# Monoid app development

Source: `../records.md`, records 13, 14, 25 and 26. Treat these records as authoritative and keep them up to date.

- The app (Ionic React + Capacitor, Android) drives the card applets of the sibling repo `monoid-javacard`, which owns the card protocol. The app mirrors its commands as x-value schemas in `src/@lib/monoid/monoid-applet.ts`, on top of the generic `CBORApplet`/`Applet` transport in `src/@lib`.
- The project is old: point out whenever the user's choices conflict with the interactions its existing code implies.
- When a wallet list is the main content of a page (including Transactions wallet selection), use the shared roomy layout by default. Embedded account summaries opt into `WalletAccountList`'s `compact` spacing; `compactContent` separately controls the gap between tags and address.
- Verify from the repo root with `npx tsc --build --pretty false` and `npx prettier --check <files>`.
- Run ESLint from `src`, e.g. `Push-Location src; npx eslint --report-unused-disable-directives '<path>'; Pop-Location`. From the root it fails with "TSConfig does not include this file". Quote `@`-prefixed paths in PowerShell.
- Lint baseline at this checkpoint: 14 errors. Twelve were already at `HEAD`, in `@app.tsx`, `use-input-modal.tsx` and `setup-card-view.tsx`; two come from the `MonoidStorageService` stub. tsc is clean.
