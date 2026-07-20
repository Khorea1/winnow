#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.WINNOW_DATA_DIR || process.env.DATA_DIR || process.cwd();
const pidPath = path.resolve(dataDir, '.winnow.pid');

if (!fs.existsSync(pidPath)) {
  console.error(`No PID file found at ${pidPath}. Is winnow running?`);
  process.exit(1);
}

const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
if (isNaN(pid)) {
  console.error(`Invalid PID in ${pidPath}`);
  process.exit(1);
}

console.log(`Stopping winnow (PID ${pid})...`);

try {
  process.kill(pid, 'SIGTERM');
} catch (err) {
  if (err.code === 'ESRCH') {
    console.log('Process already exited.');
    fs.unlinkSync(pidPath);
    process.exit(0);
  }
  throw err;
}

// Poll for process exit
const start = Date.now();
const TIMEOUT = 12_000;
while (Date.now() - start < TIMEOUT) {
  await new Promise(r => setTimeout(r, 500));
  try {
    process.kill(pid, 0);
  } catch {
    // Process is gone
    console.log('Process stopped gracefully.');
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }
}

// Force kill
console.log('Force killing...');
try {
  process.kill(pid, 'SIGKILL');
  console.log('Process killed.');
  try { fs.unlinkSync(pidPath); } catch {}
  process.exit(0);
} catch {
  console.error('Could not kill process.');
  process.exit(1);
}
