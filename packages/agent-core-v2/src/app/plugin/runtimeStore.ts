import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';

export class RuntimeStore {
  private readonly initializedLogs = new Set<string>();
  constructor(private readonly file: string) {}

  private logFile(key: string): string {
    if (!key || key.length > 1024) throw new Error('Invalid plugin journal key');
    return `${this.file}.${createHash('sha256').update(key).digest('hex')}.jsonl`;
  }

  async append(key: string, value: unknown): Promise<void> {
    const file = this.logFile(key);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Journal entries must be JSON data');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(file, { realpath: false, retries: { retries: 50, minTimeout: 5, maxTimeout: 100 } });
    try {
      if (!this.initializedLogs.has(file)) {
        try {
          const bytes = await readFile(file);
          if (bytes.length > 0 && bytes.at(-1) !== 10) await truncate(file, bytes.lastIndexOf(10) + 1);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.initializedLogs.add(file);
      }
      await appendFile(file, encoded + '\n', { encoding: 'utf8', mode: 0o600 });
    } finally { await release(); }
  }

  async readLog<T>(key: string): Promise<T[]> {
    let text: string;
    try { text = await readFile(this.logFile(key), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
  }

  async read(): Promise<Record<string, unknown>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return Object.assign(Object.create(null) as Record<string, unknown>, value);
      throw new Error(`Invalid plugin store: ${this.file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, unknown>;
      throw error;
    }
  }

  async update<T>(key: string, update: (value: T | undefined) => T | undefined): Promise<T | undefined> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 50, minTimeout: 5, maxTimeout: 100 } });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const data = await this.read();
      const value = update(data[key] as T | undefined);
      if (value === undefined) delete data[key];
      else data[key] = value;
      await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
      return value;
    } finally {
      await rm(temporary, { force: true });
      await release();
    }
  }
}
