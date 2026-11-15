// An object-store boundary for binding backups.
//
// The local filesystem store expresses the existing single-JSON-file behaviour
// through the boundary. The in-memory store is a stub that behaves like a remote
// object store where it matters for a restore: a conditional put refuses to
// replace an existing key, and a read returns a checksum over the bytes served.
// It is NOT S3. See the note at the bottom of this file for what a real target
// would still need.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as errore from 'errore'
import type { KimakiDb } from '../db.ts'
import { ConfigError } from '../errors.ts'
import {
  importBindings, sealBindingBackup, verifySealing,
  type BindingBackup, type ImportBindingsResult, type SealedBindingBackup,
} from './bindings.ts'

export class BackupStoreError extends errore.createTaggedError({
  name: 'BackupStoreError',
  message: 'Backup store $operation failed: $reason',
}) {}

// `ifNoneMatch` is the conditional put. True means "create only": an existing
// key is refused rather than overwritten (an HTTP `If-None-Match: *`). Defaults
// to true, so a plain upload can never silently replace a backup.
export type ObjectStorePutOptions = { ifNoneMatch?: boolean }

export type ObjectStoreReceipt = {
  key: string
  size: number
  etag: string
}

// `checksum` is computed over the bytes actually served, so a caller can compare
// a transport read against a digest it already trusts.
export type ObjectStoreObject = {
  key: string
  bytes: Uint8Array
  checksum: string
}

export type ObjectStore = {
  put(key: string, bytes: Uint8Array, options?: ObjectStorePutOptions): Promise<ObjectStoreReceipt | Error>
  get(key: string): Promise<ObjectStoreObject | Error>
  has(key: string): Promise<boolean | Error>
  list(prefix?: string): Promise<string[] | Error>
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function validKey(key: string): string | ConfigError {
  // Keys are flat object names here. No traversal, no separators, no absolute path.
  if (typeof key !== 'string' || key.trim() === '' || key.length > 512) {
    return new ConfigError({ reason: 'Supply a nonblank backup object key of at most 512 characters' })
  }
  if (key === '.' || key === '..' || /[/\\]/.test(key) || path.isAbsolute(key)) {
    return new ConfigError({ reason: `Backup object key ${key} must be a flat name without path separators` })
  }
  return key
}

// ---------------------------------------------------------------- local files

export function createLocalFilesystemStore({ dir }: { dir: string }): ObjectStore {
  const target = (key: string): string => path.join(dir, key)
  return {
    async put(key, bytes, options = {}) {
      const name = validKey(key)
      if (name instanceof Error) return name
      await fs.mkdir(dir, { recursive: true })
      try {
        // 'wx' is the filesystem's conditional create: it fails if the file exists.
        if (options.ifNoneMatch !== false) {
          await fs.writeFile(target(name), bytes, { flag: 'wx' })
        } else {
          await fs.writeFile(target(name), bytes)
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
          return new BackupStoreError({ operation: 'put', reason: `key ${name} already exists. Pass replace to overwrite it` })
        }
        return new BackupStoreError({ operation: 'put', reason: `${name} could not be written: ${(cause as Error).message}` })
      }
      return { key: name, size: bytes.byteLength, etag: sha256Hex(bytes) }
    },
    async get(key) {
      const name = validKey(key)
      if (name instanceof Error) return name
      try {
        const bytes = new Uint8Array(await fs.readFile(target(name)))
        return { key: name, bytes, checksum: sha256Hex(bytes) }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          return new BackupStoreError({ operation: 'get', reason: `no backup object ${name}` })
        }
        return new BackupStoreError({ operation: 'get', reason: `${name} could not be read: ${(cause as Error).message}` })
      }
    },
    async has(key) {
      const name = validKey(key)
      if (name instanceof Error) return name
      try {
        await fs.access(target(name))
        return true
      } catch {
        return false
      }
    },
    async list(prefix = '') {
      try {
        const names = await fs.readdir(dir)
        return names.filter((name) => name.startsWith(prefix)).sort()
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        return new BackupStoreError({ operation: 'list', reason: `${dir} could not be listed: ${(cause as Error).message}` })
      }
    },
  }
}

// ------------------------------------------------------------ in-memory stub

export type InMemoryObjectStore = ObjectStore & {
  // Test hook: mutate the bytes held under a key, as a broken transport or a
  // partial write would. Returns false when the key does not exist.
  tamper(key: string, mutate: (bytes: Uint8Array) => Uint8Array): boolean
}

export function createInMemoryObjectStore(): InMemoryObjectStore {
  const objects = new Map<string, Uint8Array>()
  return {
    async put(key, bytes, options = {}) {
      const name = validKey(key)
      if (name instanceof Error) return name
      if (options.ifNoneMatch !== false && objects.has(name)) {
        return new BackupStoreError({ operation: 'put', reason: `key ${name} already exists. Pass replace to overwrite it` })
      }
      const held = new Uint8Array(bytes)
      objects.set(name, held)
      return { key: name, size: held.byteLength, etag: sha256Hex(held) }
    },
    async get(key) {
      const name = validKey(key)
      if (name instanceof Error) return name
      const held = objects.get(name)
      if (!held) return new BackupStoreError({ operation: 'get', reason: `no backup object ${name}` })
      // A copy, so a caller cannot mutate stored bytes through the returned view.
      const bytes = new Uint8Array(held)
      return { key: name, bytes, checksum: sha256Hex(bytes) }
    },
    async has(key) {
      const name = validKey(key)
      if (name instanceof Error) return name
      return objects.has(name)
    },
    async list(prefix = '') {
      return [...objects.keys()].filter((name) => name.startsWith(prefix)).sort()
    },
    tamper(key, mutate) {
      const held = objects.get(key)
      if (!held) return false
      objects.set(key, new Uint8Array(mutate(new Uint8Array(held))))
      return true
    },
  }
}

// ------------------------------------------------------------ upload / restore

export type UploadedBindingBackup = {
  key: string
  size: number
  etag: string
  digest: string
}

// Seals the backup (adds the content digest) and writes it as UTF-8 JSON bytes.
// The digest is computed before the put, so the caller learns it only if the
// bytes were accepted.
export async function uploadBindingBackup({ store, key, backup, replace = false }: {
  store: ObjectStore
  key: string
  backup: BindingBackup
  replace?: boolean
}): Promise<UploadedBindingBackup | ConfigError | Error> {
  const sealed = sealBindingBackup(backup)
  if (sealed instanceof Error) return sealed
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(sealed), 'utf8'))
  const receipt = await store.put(key, bytes, { ifNoneMatch: !replace })
  if (receipt instanceof Error) return receipt
  return { key: receipt.key, size: receipt.size, etag: receipt.etag, digest: sealed.digest }
}

export type RestoredBindingBackup = ImportBindingsResult & {
  version: 1
  exportedAt: number
  digest: string
}

// A restore is read -> parse -> verify digest -> version -> rows -> one
// transaction. Nothing is written before the digest and version agree, and the
// row insert itself is all-or-nothing inside importBindings.
export async function restoreBindingBackup({ store, key, db }: {
  store: ObjectStore
  key: string
  db: KimakiDb
}): Promise<RestoredBindingBackup | ConfigError | Error> {
  const object = await store.get(key)
  if (object instanceof Error) return object
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(object.bytes).toString('utf8'))
  } catch {
    return new ConfigError({ reason: `Backup object ${key} is not readable JSON. Its payload is truncated or corrupt; refusing to restore it` })
  }
  const backup = verifySealing(parsed)
  if (backup instanceof Error) return backup
  const result = await importBindings({ db, backup })
  if (result instanceof Error) return result
  return { ...result, version: 1, exportedAt: backup.exportedAt, digest: (parsed as SealedBindingBackup).digest }
}

// Honest scope note. This stub reproduces the semantics a restore depends on,
// but it is not an object store:
// - no network transport, so no retries, timeouts, redirects or partial reads;
// - checksums are returned, not enforced server-side (S3 validates a stored
//   checksum on GET and a real adapter should compare it before handing bytes on);
// - no versioning, object lock, lifecycle rules, multi-part upload or ranged GET;
// - no conditional delete, no listing pagination, no per-object ACL or SSE-KMS;
// - no cross-region replication, so no durability guarantee at all.
// A real target would supply a credential-scoped client, retry/backoff on 5xx and
// 429, compare the stored checksum on read, and use a bucket policy that denies
// overwrite of the backup prefix so conditional put is enforced by the service,
// not only by this client.
