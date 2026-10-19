# Applet installation bundle

The bundled Monoid Identity and Monoid CAPs are refreshed from
`../monoid-javacard/build/javacard` at the start of `npm run build:web`. Ionic builds
and `npm run ios:sync` use this same build entry. Their CAP hashes, load-image
hashes and AIDs are recorded in `manifest.json`. Setup installs this bundled version.

Build the JavaCard project before building the app. The app build does not compile
firmware, and missing or invalid CAPs stop the build instead of keeping an old
bundle. Plain TypeScript compilation (`npm run build`) and the development server
do not refresh applets. Use `npm run build:web` for app packaging.

To refresh only the bundled applets, run from the app repository:

```sh
npm run prepare:applets
```

To prepare a bundle from another source directory:

```powershell
node scripts/prepare-applets.mjs <approved-cap-directory>
npx prettier --write src/@lib/monoid/@applet-bundle.ts src/@assets/applets/manifest.json
```

The source directory must contain `monoididentity.cap` and `monoid.cap`.
The preparation script validates the standard package/applet AIDs,
copies both CAPs, extracts the components in Java Card load order, records SHA-256 hashes,
and generates the bundle descriptor. It never builds or modifies the firmware
project. Review and commit the CAP bundle, load images, manifest, and descriptor
together. The app verifies the load images against the descriptor before sending
management commands.

Installation proceeds in dependency order: Monoid Identity (`00`), then Monoid (`02`).
Monoid owns Safe storage and both PINs. An existing matching Monoid Identity is
preserved. There is no separate Safe applet, old-layout compatibility or automatic
migration. The installer does not replace an already installed applet.
Reinstalling Monoid separately clears its items and both PINs; preserving the
matching Identity retains its stable ID, public key and Bundle membership needed
to recover previously exported items. Installation verifies the full Hello response
before continuing to PIN setup.

The installer supports the public factory management key with SCP02 i=55 and
SCP03 S8. It does not rotate keys, provision domains, or delete card content.
