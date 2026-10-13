import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { claimPidFile } from '../pid.js';

describe('claimPidFile', () => {
  function withPidFile(run: (pidFile: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-pid-'));
    try {
      run(path.join(dir, '.winnow.pid'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('creates a PID file if none exists', () => {
    withPidFile((pidFile) => {
      assert.equal(claimPidFile(pidFile), 'claimed');
      assert.equal(fs.readFileSync(pidFile, 'utf8'), String(process.pid));
    });
  });

  it('preserves existing PID on successful probe or EPERM', () => {
    withPidFile((pidFile) => {
      fs.writeFileSync(pidFile, '12345');
      assert.equal(
        claimPidFile(pidFile, (pid) => assert.equal(pid, 12345)),
        'running',
      );
      assert.equal(
        claimPidFile(pidFile, () => {
          throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        }),
        'running',
      );
      assert.equal(fs.readFileSync(pidFile, 'utf8'), '12345');
    });
  });

  it('replaces a stale PID only on ESRCH', () => {
    withPidFile((pidFile) => {
      fs.writeFileSync(pidFile, '12345');
      assert.equal(
        claimPidFile(pidFile, () => {
          throw Object.assign(new Error('no process'), { code: 'ESRCH' });
        }),
        'claimed',
      );
      assert.equal(fs.readFileSync(pidFile, 'utf8'), String(process.pid));
    });
  });
});
