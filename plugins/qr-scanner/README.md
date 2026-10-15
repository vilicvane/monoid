# QR scanner plugin

This local Capacitor plugin provides an Android camera preview and continuous QR
detection. Its web fallback rejects scanner calls with `UNSUPPORTED`; no iOS
implementation is provided. The plugin uses CameraX 1.4.2 and the bundled ML Kit
Barcode Scanning 17.3.0 model, configured for QR codes, with the project's existing
Android API 35 build toolchain.

## Preview

Place a CameraX `PreviewView` below the WebView in `COMPATIBLE` mode. The Scan page
owns the transparent preview opening, viewfinder, instructions and buttons. HTML
dialogs and error messages remain above the preview.

`previewBounds` describes the preview rectangle relative to the WebView viewport:
`x`, `y`, `width` and `height` are fractions, not CSS pixels or Android dp. The
page measures its preview element after layout and divides its rectangle by the
viewport dimensions. Native code maps these fractions to the WebView's bounds.
Safe insets are included in the page layout and must not be added again natively.
Update the bounds after layout changes. A rectangle that rounds to zero pixel
area is invalid. `updatePreviewBounds` acknowledges the layout request; detection
pauses while a changed viewport is rebound. Moving an unchanged rectangle does
not require rebinding the camera.

After `startScan` resolves, `animatePreview` scales the native preview around its
center without changing layout, the analysis crop or camera zoom. The caller
supplies `fromScale`, `toScale`, a duration in milliseconds and four CSS
`cubic-bezier` control points. Scales must be positive finite Android float values,
duration must be nonnegative and fit Android's millisecond duration, and the two
x control points must be in `[0, 1]`. Y control points may overshoot. The initial
scale is applied immediately; the promise resolves when the animation starts,
not when it finishes. A zero duration applies the final scale immediately.
Each call replaces any previous preview animation. Stopping or hiding the preview
cancels it. A pending, closed or different scan ID rejects with `SCAN_CLOSED`.
Keep the HTML opening covered until this call resolves when revealing a preview.

Bind preview and image analysis to the same CameraX viewport. Return only codes
whose full bounds lie inside the analysis crop rectangle, accounting for image
rotation. Sharing a viewport alone does not crop the image passed to ML Kit.
Restore the WebView background and remove the native preview
when scanning ends; transparent DOM styles belong to the active Scan page.
The bridge passes the configured WebView background color (white by default) to
the camera session for restoration; the WebView's ordinary background drawable
is not sufficient.

## Lifecycle

- Request camera permission before starting. Register listeners before calling
  `startScan`; it resolves when the first preview frame is ready. Keep the preview
  opening covered by a loading surface until then, and fade that surface away to
  reveal the camera. No QR results are emitted before startup resolves.
- Only one scan may be starting or active. Another start rejects `BUSY`.
- Every scan uses a fresh `scanId`. Stopping an ID retires it until the plugin
  reloads, including an unknown ID, so a delayed start cannot reopen the camera.
- `stopScan` cancels pending startup, waits for native cleanup and never stops a
  different ID. Reusing a retired ID rejects `SCAN_CLOSED`.
- Backgrounding the app ends the scan. Foregrounding does not restart it. Native
  destruction also releases resources, without requiring JavaScript cleanup.
- Startup failures reject `startScan`; failures after startup end the scan and
  emit `scanEnded`. Explicit stop and backgrounding also emit `scanEnded` once
  for an active scan. A cancelled pending start rejects `CANCELLED`.
- No new results are emitted after a scan ends. The page still checks `scanId`
  because JavaScript may receive events queued before cancellation.
- Detection is continuous. The page handles repeated results and decides when
  to stop scanning or start another scan. Only raw QR text crosses the bridge;
  WalletConnect, Passkey and navigation logic belong to the application.

## Android analyzer

`QrCodeAnalyzer` consumes CameraX frames and returns raw text only for QR codes
fully inside the visible crop. It rotates the crop to match ML Kit result
coordinates and releases every frame after detection completes. Calls and
callbacks run on the same serial executor. On stop, clear the CameraX analyzer,
then call `close` and wait for its callback before unbinding camera use cases.
`QrCameraSession` owns that ordering with a dedicated lifecycle. The bridge closes
it on app pause, WebView reload, renderer loss and activity destruction. CameraX
provider initialization is also cancellable from the caller's perspective: an
initialization callback cannot create a preview after its scan has ended.
Startup observes `PreviewView` stream state; in `COMPATIBLE` mode, `STREAMING`
means a TextureView frame has arrived. The observer is removed during rebind and
close, so cancelling before the first frame follows the same pending-start path.

With JDK 21 and `ANDROID_HOME` set to an SDK containing API 35, run from the
repository root:

```powershell
.\android\gradlew.bat -p plugins/qr-scanner/android testDebugUnitTest assembleDebug lintDebug --console=plain
```
