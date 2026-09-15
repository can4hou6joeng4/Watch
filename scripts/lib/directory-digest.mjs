import { createHash } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

// Snapshot owned fixture data without following native runtime symlinks.
export async function directoryDigest(root, excludeRootEntries = []) {
  const excluded = new Set(excludeRootEntries);
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === root && excluded.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
      hash.update(JSON.stringify([path.relative(root, file), type])).update('\n');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) hash.update(createHash('sha256').update(await readFile(file)).digest());
      else if (entry.isSymbolicLink()) hash.update(JSON.stringify(await readlink(file))).update('\n');
    }
  }
  await walk(root);
  return hash.digest('hex');
}
