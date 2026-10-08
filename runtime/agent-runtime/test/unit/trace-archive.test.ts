/** Trace archive without a database: pointers, paths, verification of a written file. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/audit/summary.js';
import {
  ArchiveVerificationError,
  isArchivePointer,
  readArchiveLine,
  resolveArchiveFile,
  retentionDaysFromEnv,
  archiveDirFromEnv,
  tenantDirName,
  verifyArchiveFile,
  type ArchiveLine,
} from '../../src/maintenance/trace-archive.js';

const line = (stepId: string, output: unknown): ArchiveLine => ({
  v: 1,
  tenant_id: 't',
  trace_id: 'tr',
  step_id: stepId,
  sequence: 1,
  type: 'TOOL',
  timestamp: '2026-01-01T00:00:00.000Z',
  archived_at: '2026-10-08T00:00:00.000Z',
  fields: { output },
  sha256: { output: 'x' },
});

function writeArchive(dir: string, name: string, lines: ArchiveLine[]): { abs: string; sha: string } {
  const content = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const abs = path.join(dir, name);
  writeFileSync(abs, gzipSync(content));
  return { abs, sha: sha256Hex(content) };
}

describe('trace archive helpers', () => {
  it('recognises only archive pointers', () => {
    expect(isArchivePointer({ archived: true, file: 'a/2026-01.jsonl.gz', line: 1, field: 'output', sha256: 'x', bytes: 1 })).toBe(true);
    expect(isArchivePointer({ archived: 'true', file: 'a', line: 1 })).toBe(false);
    expect(isArchivePointer([{ archived: true }])).toBe(false);
    expect(isArchivePointer(null)).toBe(false);
  });

  it('maps tenant ids to safe directory names', () => {
    expect(tenantDirName('publiexpe')).toBe('publiexpe');
    expect(tenantDirName('../etc')).toBe('___etc');
    expect(tenantDirName('..')).toBe('__');
  });

  it('refuses pointer files outside the archive directory', () => {
    const root = path.resolve('/srv/archive');
    expect(resolveArchiveFile(root, 'publiexpe/2026-01.jsonl.gz')).toBe(path.join(root, 'publiexpe', '2026-01.jsonl.gz'));
    expect(() => resolveArchiveFile(root, '../secrets.txt')).toThrow(/outside/);
    expect(() => resolveArchiveFile(root, path.resolve('/etc/passwd'))).toThrow(/outside/);
  });

  it('reads the defaults from the environment', () => {
    expect(retentionDaysFromEnv({})).toBe(90);
    expect(retentionDaysFromEnv({ TRACE_RETENTION_DAYS: '30' })).toBe(30);
    expect(() => retentionDaysFromEnv({ TRACE_RETENTION_DAYS: '-1' })).toThrow();
    expect(archiveDirFromEnv({})).toBe('./data/trace-archive');
    expect(archiveDirFromEnv({ TRACE_ARCHIVE_DIR: '/data/x' })).toBe('/data/x');
  });

  it('verifies a written file and detects any difference', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pxos-archive-unit-'));
    const lines = [line('s1', { text: 'a'.repeat(100) }), line('s2', [1, 2, 3])];
    const ok = writeArchive(dir, 'ok.jsonl.gz', lines);
    await expect(verifyArchiveFile(ok.abs, { sha256: ok.sha, lines })).resolves.toBeUndefined();
    expect(JSON.parse((await readArchiveLine(ok.abs, 2))!).step_id).toBe('s2');
    expect(await readArchiveLine(ok.abs, 3)).toBeNull();

    // Same lines, other content hash expected; one line missing; one value changed.
    await expect(verifyArchiveFile(ok.abs, { sha256: 'f'.repeat(64), lines })).rejects.toBeInstanceOf(ArchiveVerificationError);
    const short = writeArchive(dir, 'short.jsonl.gz', lines.slice(0, 1));
    await expect(verifyArchiveFile(short.abs, { sha256: short.sha, lines })).rejects.toThrow(/line count/);
    const changed = writeArchive(dir, 'changed.jsonl.gz', [lines[0]!, line('s2', [1, 2, 4])]);
    await expect(verifyArchiveFile(changed.abs, { sha256: changed.sha, lines })).rejects.toThrow(/field output differs/);
  });
});
