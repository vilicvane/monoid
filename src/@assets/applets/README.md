# Applet installation bundle

The Monoid Identity, Monoid Library, Monoid and optional Monoid Security Key CAPs
are committed here with their load images and bundle descriptor, so the app can
be built without a JavaCard checkout. At the start of `npm run build:web`, the app checks for newer CAPs in
`../monoid-javacard/build/javacard`. Ionic builds and `npm run ios:sync` use this
same build entry. CAP hashes, load-image hashes, AIDs, and source modification
times are recorded in `manifest.json`. The manifest and descriptor also record
optional status, package dependencies and any distinct instance AID. This catalog
drives installation plans; Card Applets installs the selected bundled applets.

Build the JavaCard project first when you want to update the app's firmware. All four
source CAPs must exist, and each changed CAP must be newer than its recorded source
time, before the entire bundle is refreshed. Missing or older sources retain the
committed bundle; equal timestamps with different content also retain it. Identical
CAPs are not rewritten. The comparison uses the manifest, not the local copies'
file timestamps, which Git checkout does not preserve. Invalid newer CAPs stop the
build before any bundled files are written. Optional refers to the user's
installation choice; its CAP still participates in the complete bundle refresh.

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
`monoidlib.cap`, `monoid.cap` and `monoidsecuritykey.cap`.
The preparation script validates the standard package/applet AIDs,
copies all four CAPs, extracts the components in Java Card load order, records SHA-256 hashes,
and generates the bundle descriptor. It never builds or modifies the firmware
project. Review and commit the CAP bundle, load images, manifest, and descriptor
together. The app verifies the load images against the descriptor before sending
management commands.

Installation proceeds in dependency order: Monoid Identity (`00`), Monoid Library
(`04`), then Monoid (`02`), followed by the optional Monoid Security Key (`03`).
The library is a code package without an applet instance;
it is loaded without an INSTALL for install command. Monoid owns Safe storage and
Access PIN, while Identity owns Secret PIN. Initial installation preserves an
existing Monoid Identity and library. There is no separate Safe applet, old-layout compatibility or automatic
migration. Install preserves already installed applets; Update and Reinstall replace them.
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

Security Key is a separate optional client applet that depends on Monoid and its
library. Its CAP module AID is `F06D6F6E6F69640301`, while its installed instance
uses the standard FIDO NFC AID `A0000006472F0001`; `instanceAid` records this
distinction. Required applets omit `optional`, and an omitted `instanceAid` means
the instance uses the CAP applet AID. Security Key is not installed unless selected.
Maintenance includes installed dependent applets in its confirmation, removes them in reverse dependency
order and reinstalls them after their dependencies. An installed dependent that
was not selected stops maintenance before deletion. Updating only Security Key
leaves the required applets and their items in place. Reinstalling Security Key
resets its FIDO PIN. If a required dependency is known to be outdated, adding or
updating Security Key first includes the base update in the confirmation.
Fresh install removes all managed applets,
including previously installed optional applets, then reinstalls only the required
applets and the current optional selection.

The current Security Key credential format requires CBOR field `10` (32-byte scope)
and the 64-byte lookup key `scope || SHA256(rpId)`. Scope derives from the Seed
contents and grant domain, independently of local Seed index, card identity or
installation token. Old records without scope are not migrated or accepted by
Copy/Sync. Distinct credential indices coexist; equal indices with different
metadata or payloads conflict. Alias handling follows each flow's existing rules.
Copy/Sync transfer public credential records without granting access or inferring
a Seed association; Secret transfers retain their existing protocol boundaries.

Update and Reinstall preserve applet grant scopes (`aid`, `types`, `keys`, `seed`),
never installation tokens or `tokenHash`. Non-Bundle cards restore their archived
items first, then rebind grants to the new applet instances and verify the scopes.
Bundle cards require copying items to another bundle card before replacement and
restoring them manually afterward. Their saved grants remain available through
Restore applet access; pending grant recovery blocks another ordinary replacement.
This is same-card maintenance recovery; Copy and Sync never migrate grants to
another card.

Before replacement, the installer reads all loaded packages and applet instances.
Unrelated packages remain untouched. It rejects unknown modules or extra instances
inside a selected replacement package. Known installed dependents must be included
in the replacement plan. Non-cascading DELETE lets GP reject removal when another
package still depends on it. CAP imports are recorded in the manifest for inspection.

The installer supports the public factory management key with SCP02 i=55 and
SCP03 S8. It does not rotate keys or provision domains. Deletion is restricted to
the explicitly selected replacement operation and never requests cascading removal.
