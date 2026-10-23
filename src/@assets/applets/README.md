# Applet installation bundle

The Monoid Identity, Monoid Library and Monoid CAPs are committed here with their
load images and bundle descriptor, so the app can be built without a JavaCard checkout. At the
start of `npm run build:web`, the app checks for newer CAPs in
`../monoid-javacard/build/javacard`. Ionic builds and `npm run ios:sync` use this
same build entry. CAP hashes, load-image hashes, AIDs, and source modification
times are recorded in `manifest.json`. Setup installs this bundled version.

Build the JavaCard project first when you want to update the app's firmware. All
source CAPs must exist, and each changed CAP must be newer than its recorded source
time, before the entire bundle is refreshed. Missing or older sources retain the
committed bundle; equal timestamps with different content also retain it. Identical
CAPs are not rewritten. The comparison uses the manifest, not the local copies'
file timestamps, which Git checkout does not preserve. Invalid newer CAPs stop the
build before any bundled files are written.

The app build never compiles firmware. Plain TypeScript compilation (`npm run build`)
and the development server do not refresh applets. Use `npm run build:web` for app
packaging.

To refresh only the bundled applets, run from the app repository:

```sh
npm run prepare:applets
```

To prepare a bundle from another source directory:

```powershell
node scripts/prepare-applets.mjs <approved-cap-directory>
npx prettier --write src/@lib/monoid/@applet-bundle.ts src/@assets/applets/manifest.json
```

To refresh the bundle, the source directory must contain `monoididentity.cap`,
`monoidlib.cap` and `monoid.cap`.
The preparation script validates the standard package/applet AIDs,
copies all three CAPs, extracts the components in Java Card load order, records SHA-256 hashes,
and generates the bundle descriptor. It never builds or modifies the firmware
project. Review and commit the CAP bundle, load images, manifest, and descriptor
together. The app verifies the load images against the descriptor before sending
management commands.

Installation proceeds in dependency order: Monoid Identity (`00`), Monoid Library
(`04`), then Monoid (`02`). The library is a code package without an applet instance;
it is loaded without an INSTALL for install command. Monoid owns Safe storage and
Access PIN, while Identity owns Secret PIN. Initial installation preserves an
existing Monoid Identity and library. There is no separate Safe applet, old-layout compatibility or automatic
migration. The installer does not replace an already installed applet.
Updating or reinstalling Monoid also refreshes its matching library and clears
Monoid's items and Access PIN; preserving the
matching Identity retains Secret PIN, stable ID, public key and Bundle membership needed
to recover previously exported items. Installation verifies the full Hello response
before continuing to PIN setup.

This snapshot requires its matching Identity implementation: the Bundle contract
and shared-interface method tokens changed while the package version stayed at
`0.0`. Older test cards need an explicit Fresh install of the complete bundle,
which clears their items, PINs and identity. The app does not add compatibility
detection or migration for this development transition.

Security Key is a separate optional client applet and is not included in this bundle.
Its installation and updates are not managed by the app. If an installed Security
Key package depends on Monoid or its library, maintenance stops before deletion
instead of removing the dependent package and its data.
Automatic item recovery does not restore applet grants. Update and Reinstall stop
before creating a recovery operation when grants exist, or when their list cannot
be read. Explicit Fresh install remains a separate erase operation.

The installer supports the public factory management key with SCP02 i=55 and
SCP03 S8. It does not rotate keys, provision domains, or delete card content.
