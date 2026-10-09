type NativeConnectionFailure = { kind: 'certificate' | 'tls' | 'policy' | 'timeout' | 'network' | 'unknown'; message: string };
/** Use native URL error codes when present. Never include a raw URL, credential or exception in UI copy. */
export const classifyNativeConnectionFailure = (error: unknown): NativeConnectionFailure => {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = Number(value.code);
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  if ([-1201, -1202, -1203, -1204, -1205, -1206].includes(code) || /certificate|certpath|trust anchor/.test(message)) return { kind: 'certificate', message: 'iOS could not verify the host certificate. Check its hostname, expiry and trusted certificate chain.' };
  if (code === -1200 || /ssl|tls|secure connection/.test(message)) return { kind: 'tls', message: 'The secure connection failed. Check the host TLS configuration.' };
  if (code === -1022 || /app transport security|cleartext.*not permitted/.test(message)) return { kind: 'policy', message: 'Device network policy blocked this connection. Use a trusted HTTPS endpoint.' };
  if (code === -1001 || /timed? ?out|timeout/.test(message)) return { kind: 'timeout', message: 'The host did not respond in time. Check connectivity, then retry.' };
  if ([-1003, -1004, -1009].includes(code) || /offline|internet connection|could not connect|host.*not.*found/.test(message)) return { kind: 'network', message: 'The host could not be reached. Check Wi-Fi, VPN, host address and Local Network permission.' };
  return { kind: 'unknown', message: 'The native request failed. Check the connection and export diagnostics if it continues.' };
};

let latestFailure: NativeConnectionFailure | null = null;
const listeners = new Set<() => void>();
export const getNativeConnectionFailure = () => latestFailure;
export const subscribeNativeConnectionFailure = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const setNativeConnectionFailure = (failure: NativeConnectionFailure | null): void => {
  latestFailure = failure;
  listeners.forEach((listener) => listener());
};
