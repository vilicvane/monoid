export function isOperationCancelled(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError') ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'CANCELLED' || error.code === 'APP_INACTIVE'))
  );
}
