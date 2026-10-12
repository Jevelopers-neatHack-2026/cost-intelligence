import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hashExportCanonical, validStoredExport, type ExportArtifactStorePort, type StoredExportArtifacts } from './runtime.js';
import { validReportingStoredExport, type ReportingExportArtifactStorePort } from './reporting-export.js';

const MAX_STORED_BYTES = 1_048_576;
/**
 * Task-local filesystem adapter. The host owns its directory and access policy.
 * One fsynced file contains bytes and receipts; an exclusive hard link publishes
 * it atomically. A lost acknowledgement therefore replays the original bundle,
 * including its actual preparation time. No financial balance is stored here.
 */
type FileStoreOptions = { readonly directory: string; readonly receiptKey: Uint8Array };
type ImmutableStore<T> = { lookup(keyHash: string): Promise<T | null>; commitImmutable(keyHash: string, value: T): Promise<T>; verifyOriginal(keyHash: string, value: T): Promise<boolean> };
export function createFileExportArtifactStore(options: FileStoreOptions): ExportArtifactStorePort {
  return createFileArtifactStore<StoredExportArtifacts>(options, validStoredExport);
}
export function createFileReportingExportArtifactStore(options: FileStoreOptions): ReportingExportArtifactStorePort {
  return createFileArtifactStore(options, validReportingStoredExport);
}
function createFileArtifactStore<T>(options: FileStoreOptions, validate: (value: unknown) => value is T): ImmutableStore<T> {
  if (!(options.receiptKey instanceof Uint8Array) || options.receiptKey.length < 32) throw new Error('An authenticated artifact receipt key is required.');
  const receiptKey = new Uint8Array(options.receiptKey);
  const directory = resolve(options.directory);
  const seal = (keyHash: string, value: T) => createHmac('sha256', receiptKey).update(hashExportCanonical({ keyHash, value }), 'utf8').digest('hex');
  const fileFor = (keyHash: string) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(keyHash)) throw new Error('Invalid artifact key.');
    return join(directory, keyHash.slice(7) + '.json');
  };
  const ensureDirectory = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid artifact directory.');
  };
  const lookup = async (keyHash: string): Promise<T | null> => {
    const path = fileFor(keyHash);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw new Error('Artifact read unavailable.');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STORED_BYTES) throw new Error('Invalid artifact size.');
      const record: unknown = JSON.parse(await handle.readFile('utf8'));
      if (typeof record !== 'object' || record === null || Object.keys(record).sort().join(',') !== 'authenticationTag,keyHash,value') throw new Error('Invalid artifact receipt.');
      const envelope = record as { authenticationTag: string; keyHash: string; value: unknown };
      if (envelope.keyHash !== keyHash || !validate(envelope.value)
          || typeof envelope.authenticationTag !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.authenticationTag)
          || !timingSafeEqual(new TextEncoder().encode(envelope.authenticationTag), new TextEncoder().encode(seal(keyHash, envelope.value)))) throw new Error('Invalid authenticated artifact receipt.');
      return envelope.value;
    } finally { await handle.close(); }
  };
  return {
    lookup,
    async verifyOriginal(keyHash, value) {
      const original = await lookup(keyHash);
      return original !== null && hashExportCanonical(original) === hashExportCanonical(value);
    },
    async commitImmutable(keyHash, value) {
      if (!validate(value)) throw new Error('Invalid artifact receipt.');
      const bytes = JSON.stringify({ keyHash, value, authenticationTag: seal(keyHash, value) }) + '\n';
      if (new TextEncoder().encode(bytes).length > MAX_STORED_BYTES) throw new Error('Invalid artifact size.');
      await ensureDirectory();
      const temporary = join(directory, '.prepare-' + globalThis.crypto.randomUUID());
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          await handle.writeFile(bytes, 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        try { await link(temporary, fileFor(keyHash)); }
        catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
        }
        const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        const original = await lookup(keyHash);
        if (original === null) throw new Error('Artifact receipt unavailable.');
        return original;
      } finally { await unlink(temporary); }
    },
  };
}
