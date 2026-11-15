import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function kronosHome(): string {
  return process.env.KRONOS_HOME ?? path.join(os.homedir(), '.kronos');
}

export function projectDataDir(root: string): string {
  const id = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  return path.join(kronosHome(), 'projects', `${path.basename(root)}-${id}`);
}
