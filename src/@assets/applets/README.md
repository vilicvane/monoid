# Applet installation bundle

No CAP pair is currently selected. Installation remains disabled until the
Java Card project supplies the intended firmware pair.

To bundle that pair, run from the app repository:

```powershell
node scripts/prepare-applets.mjs <directory-containing-monoidsafe.cap-and-monoid.cap>
npx prettier --write src/@lib/monoid/@applet-bundle.ts src/@assets/applets/manifest.json
```

The preparation script validates the standard package/applet AIDs, copies both
CAPs, extracts the components in Java Card load order, records SHA-256 hashes,
and generates the bundle descriptor. It never builds or modifies the firmware
project. Review and commit the CAP pair, load images, manifest, and descriptor
together. The app verifies the load images against the descriptor before sending
management commands.

The installer supports the public factory management key with SCP02 i=55 and
SCP03 S8. It does not rotate keys, provision domains, or delete card content.
