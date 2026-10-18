# Applet installation bundle

The bundled Safe Identity, Safe and Monoid CAPs were selected from the Java Card
build output dated 2026-10-18 19:10 (Asia/Shanghai). Their CAP hashes, load-image
hashes and AIDs are recorded in `manifest.json`. Setup installs this bundled version.

To bundle all three CAP files, run from the app repository:

```powershell
node scripts/prepare-applets.mjs <approved-cap-directory>
npx prettier --write src/@lib/monoid/@applet-bundle.ts src/@assets/applets/manifest.json
```

The source directory must contain `monoidsafeidentity.cap`, `monoidsafe.cap` and
`monoid.cap`. The preparation script validates the standard package/applet AIDs,
copies all three CAPs, extracts the components in Java Card load order, records SHA-256 hashes,
and generates the bundle descriptor. It never builds or modifies the firmware
project. Review and commit the CAP bundle, load images, manifest, and descriptor
together. The app verifies the load images against the descriptor before sending
management commands.

Installation proceeds in dependency order: Safe Identity, Safe, then Monoid.
An existing Safe Identity is preserved. Earlier firmware assigned AIDs `00` and
`01` to Safe and Monoid; the new layout assigns `00`, `01` and `02` to Identity,
Safe and Monoid. This installer is for fresh cards or the new layout, not migration
from the earlier layout. Preserve old items before separately migrating that firmware.

The installer supports the public factory management key with SCP02 i=55 and
SCP03 S8. It does not rotate keys, provision domains, or delete card content.
