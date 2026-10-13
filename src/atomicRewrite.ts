import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

type Transform = (content: string) => string | null | Promise<string | null>;

const pendingByPath = new Map<string, Promise<void>>();

/**
 * Serialize a read-transform-replace operation for this process and target path.
 * The transform sees the latest UTF-8 file contents and may return null to leave
 * the existing file unchanged.
 */
export async function atomicRewrite(filePath: string, transform: Transform): Promise<string | null> {
  const targetPath = path.resolve(filePath);
  const previous = pendingByPath.get(targetPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  pendingByPath.set(targetPath, tail);

  await previous;
  try {
    return await rewrite(targetPath, transform);
  } finally {
    release();
    if (pendingByPath.get(targetPath) === tail) pendingByPath.delete(targetPath);
  }
}

async function rewrite(targetPath: string, transform: Transform): Promise<string | null> {
  let original: string;
  try {
    original = await readFile(targetPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    original = '';
  }
  const replacement = await transform(original);
  if (replacement === null) return null;

  let mode = 0o600;
  try {
    mode = (await stat(targetPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    created = true;
    await handle.chmod(mode);
    await handle.writeFile(replacement, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the error that caused the rewrite to fail.
      }
    }
    if (created) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Preserve the error that caused the rewrite to fail.
      }
    }
    throw error;
  }

  return replacement;
}
