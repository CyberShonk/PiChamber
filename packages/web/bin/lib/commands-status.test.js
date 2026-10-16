import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cli-lifecycle.js', () => ({
  discoverLifecycleInstances: vi.fn(),
  discoverDesktopInstance: vi.fn(),
}));

vi.mock('./cli-http.js', () => ({
  requestJson: vi.fn(),
}));

vi.mock('./cli-process.js', () => ({
  readInstanceOptions: vi.fn(),
}));

import { discoverDesktopInstance, discoverLifecycleInstances } from './cli-lifecycle.js';
import { requestJson } from './cli-http.js';
import { readInstanceOptions } from './cli-process.js';
import { statusCommand } from './commands-status.js';

async function captureOutput(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  const capture = (target) => (chunk, encoding, callback) => {
    target.value += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  const stdoutTarget = { value: '' };
  const stderrTarget = { value: '' };
  process.stdout.write = capture(stdoutTarget);
  process.stderr.write = capture(stderrTarget);
  try {
    await fn();
    stdout = stdoutTarget.value;
    stderr = stderrTarget.value;
    return { stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function stubInstance() {
  vi.mocked(discoverLifecycleInstances).mockResolvedValue([
    {
      port: 3000,
      pid: 1234,
      pidFilePath: '/tmp/pichamber-3000.pid',
      instanceFilePath: '/tmp/pichamber-3000.json',
      launchMode: 'daemon',
      runtime: 'web',
      source: 'registry',
    },
  ]);
  vi.mocked(discoverDesktopInstance).mockResolvedValue(null);
  vi.mocked(readInstanceOptions).mockReturnValue({});
}

describe('status quiet tailscale tokens', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubInstance();
  });

  it('emits tailscale state and url as separate whitespace-delimited tokens', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active', url: 'https://host.ts.net:8443', config: { mode: 'private' } },
    });

    const { stdout } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));

    expect(stdout).toContain('port 3000 mode:daemon pass:no tailscale:active tailscale-url:https://host.ts.net:8443');
    expect(stdout).not.toContain('tailscale:active:https://');
    const tokens = stdout.trim().split('\n')[0].split(/\s+/);
    expect(tokens).toContain('tailscale:active');
    expect(tokens).toContain('tailscale-url:https://host.ts.net:8443');
  });

  it('emits only the state token when no tailscale url exists', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active' },
    });

    const { stdout } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));

    const tokens = stdout.trim().split('\n')[0].split(/\s+/);
    expect(tokens).toContain('tailscale:active');
    expect(tokens.some((token) => token.startsWith('tailscale-url:'))).toBe(false);
  });

  it('omits tailscale tokens when tailscale is off', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'off' },
    });

    const { stdout } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));

    expect(stdout.trim()).toBe('port 3000 mode:daemon pass:no');
  });
});

describe('status tailscale public DNS', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubInstance();
  });

  it('includes publicDns in --json and as a quiet token only when a string', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active', url: 'https://host.ts.net', config: { mode: 'public' }, publicDns: 'pending' },
    });

    const { stdout } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));
    const tokens = stdout.trim().split('\n')[0].split(/\s+/);
    expect(tokens).toContain('tailscale-public-dns:pending');

    const jsonOut = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk) => { jsonOut.push(String(chunk)); return true; });
    try {
      await statusCommand({ explicitPort: true, port: 3000, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(jsonOut.join(''));
    expect(payload.instances[0].tailscale.publicDns).toBe('pending');
  });

  it('omits the quiet public-dns token when absent and says nothing extra for ready in human output', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active', url: 'https://host.ts.net', config: { mode: 'public' }, publicDns: 'ready' },
    });
    const { stdout: quietReady } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));
    expect(quietReady).toContain('tailscale-public-dns:ready');

    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active', url: 'https://host.ts.net', config: { mode: 'private' } },
    });
    const { stdout: quietPrivate } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000, quiet: true }));
    expect(quietPrivate).not.toContain('tailscale-public-dns:');
  });

  it('human output names pending/unknown and stays quiet for ready', async () => {
    for (const [publicDns, expected] of [['pending', 'public DNS pending'], ['unknown', 'public DNS unknown']]) {
      vi.mocked(requestJson).mockResolvedValue({
        response: { ok: true },
        body: { state: 'active', url: 'https://host.ts.net', config: { mode: 'public' }, publicDns },
      });
      const { stdout, stderr } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000 }));
      expect(`${stdout}${stderr}`).toContain(expected);
    }
    vi.mocked(requestJson).mockResolvedValue({
      response: { ok: true },
      body: { state: 'active', url: 'https://host.ts.net', config: { mode: 'public' }, publicDns: 'ready' },
    });
    const { stdout, stderr } = await captureOutput(() => statusCommand({ explicitPort: true, port: 3000 }));
    expect(`${stdout}${stderr}`).not.toContain('public DNS');
  });
});
