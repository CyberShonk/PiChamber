import { describe, expect, test } from 'bun:test';
import { classifyNativeConnectionFailure } from './connectionFailure';

describe('native transport diagnostics', () => {
  test('keeps certificate, TLS, ATS, timeout and network reasons distinct', () => {
    for (const [code, kind] of [[-1202, 'certificate'], [-1200, 'tls'], [-1022, 'policy'], [-1001, 'timeout'], [-1009, 'network']] as const) expect(classifyNativeConnectionFailure({ code }).kind).toBe(kind);
  });
  test('handles native bridge domain codes with localized-message fallback', () => {
    expect(classifyNativeConnectionFailure({ code: 'NSURLErrorDomain', message: 'The certificate for this server is invalid.' }).kind).toBe('certificate');
  });
  test('never exports raw credentials, URL or unknown exception text', () => {
    const result = classifyNativeConnectionFailure({ message: 'https://user:secret@example.com/?token=private other secret' });
    expect(result.kind).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('example.com');
  });
});
