import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cli-lifecycle.js', () => ({
  discoverRunningInstances: vi.fn(),
}));

vi.mock('./cli-http.js', () => ({
  requestJson: vi.fn(),
}));

import { discoverRunningInstances } from './cli-lifecycle.js';
import { requestJson } from './cli-http.js';
import { createConnectUrlCommand } from './commands-connect-url.js';

async function withTempPiChamberDataDir(fn) {
  const previous = process.env.PICHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-pair-test-'));
  process.env.PICHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.PICHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function captureOutput(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdoutTarget = { value: '' };
  const stderrTarget = { value: '' };
  const capture = (target) => (chunk, encoding, callback) => {
    target.value += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  process.stdout.write = capture(stdoutTarget);
  process.stderr.write = capture(stderrTarget);
  try {
    await fn();
    return { stdout: stdoutTarget.value, stderr: stderrTarget.value };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function stubRunningServer() {
  vi.mocked(discoverRunningInstances).mockResolvedValue([{ port: 3000 }]);
}

function stubTailscaleStatus(body) {
  vi.mocked(requestJson).mockResolvedValue({
    response: { status: 200, ok: true },
    body,
  });
}

describe('pair --tailscale --quiet', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubRunningServer();
  });

  it('prints only the link on stdout and the approval url on stderr for needs-approval', async () => {
    await withTempPiChamberDataDir(async () => {
      const approvalUrl = 'https://login.tailscale.com/a/abc123';
      stubTailscaleStatus({ state: 'needs-approval', approvalUrl, mode: 'private' });
      const serveCommand = vi.fn();
      const pair = createConnectUrlCommand({ serveCommand });

      const { stdout, stderr } = await captureOutput(() => pair({
        port: 3000,
        tailscale: true,
        quiet: true,
        server: 'http://127.0.0.1:3000',
      }));

      const stdoutLines = stdout.trim().split('\n');
      expect(stdoutLines).toHaveLength(1);
      expect(stdoutLines[0].startsWith('pichamber://connect')).toBe(true);
      expect(stderr).toContain('[TAILSCALE_APPROVAL]');
      expect(stderr).toContain(approvalUrl);
      expect(stderr.trim().split('\n')).toHaveLength(1);
      expect(stderr).not.toContain('pichamber://connect');
      expect(serveCommand).not.toHaveBeenCalled();
    });
  });

  it('prints nothing extra on stderr when tailscale is active', async () => {
    await withTempPiChamberDataDir(async () => {
      stubTailscaleStatus({ state: 'active', url: 'https://host.ts.net', mode: 'private' });
      const pair = createConnectUrlCommand({ serveCommand: vi.fn() });

      const { stdout, stderr } = await captureOutput(() => pair({
        port: 3000,
        tailscale: true,
        quiet: true,
        server: 'http://127.0.0.1:3000',
      }));

      const stdoutLines = stdout.trim().split('\n');
      expect(stdoutLines).toHaveLength(1);
      expect(stdoutLines[0].startsWith('pichamber://connect')).toBe(true);
      expect(stderr).toBe('');
    });
  });

  it('reports non-approval states with state and error message on stderr', async () => {
    await withTempPiChamberDataDir(async () => {
      stubTailscaleStatus({ state: 'error', errorMessage: 'daemon unreachable', mode: 'private' });
      const pair = createConnectUrlCommand({ serveCommand: vi.fn() });

      const { stdout, stderr } = await captureOutput(() => pair({
        port: 3000,
        tailscale: true,
        quiet: true,
        server: 'http://127.0.0.1:3000',
      }));

      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(stderr).toContain('[TAILSCALE_NOT_ACTIVE]');
      expect(stderr).toContain('error');
      expect(stderr).toContain('daemon unreachable');
      expect(stderr).not.toContain('pichamber://connect');
    });
  });
});
