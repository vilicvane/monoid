// Preserve the same queue across hot updates so old scanner cleanup still
// blocks a new page or popup from opening the camera.
export const qrScanLifecycle: {closing: Promise<void>} = import.meta.hot?.data
  .qrScanLifecycle ?? {closing: Promise.resolve()};

if (import.meta.hot) {
  import.meta.hot.data.qrScanLifecycle = qrScanLifecycle;
}
