import fs from 'node:fs';

type PidClaim = 'claimed' | 'running' | 'unavailable';

export function claimPidFile(pidPath: string, signal: (pid: number) => void = (pid) => process.kill(pid, 0)): PidClaim {
  try {
    fs.writeFileSync(pidPath, String(process.pid), { flag: 'wx' });
    return 'claimed';
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable';
  }

  try {
    const existingPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isSafeInteger(existingPid) && existingPid > 0) {
      try {
        signal(existingPid);
        return 'running';
      } catch (e: unknown) {
        // EPERM means an existing process cannot be signalled, not that it exited.
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return 'running';
      }
    }
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
    return 'claimed';
  } catch {
    return 'unavailable';
  }
}
