import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import { createClient } from 'redis';

export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  take(key: string): Promise<string | null>;
  close(): Promise<void>;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('invalid encrypted value');
  return Buffer.from(value, 'base64url');
}

function timestampBytes(timestamp: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(timestamp));
  return bytes;
}

/** Encrypt a value with authenticated Fernet framing. */
export function encryptValue(
  plaintext: string,
  key: Uint8Array,
  now: () => number = Date.now
): string {
  if (key.byteLength !== 32) throw new Error('encryption key must contain 32 bytes');
  const signingKey = Buffer.from(key.subarray(0, 16));
  const encryptionKey = Buffer.from(key.subarray(16));
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const signed = Buffer.concat([
    Buffer.from([0x80]),
    timestampBytes(Math.floor(now() / 1000)),
    iv,
    ciphertext
  ]);
  const signature = createHmac('sha256', signingKey).update(signed).digest();
  return base64url(Buffer.concat([signed, signature]));
}

export function decryptValue(token: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error('encryption key must contain 32 bytes');
  const decoded = decodeBase64url(token);
  const minimumLength = 1 + 8 + 16 + 16 + 32;
  if (decoded.byteLength < minimumLength || decoded[0] !== 0x80) {
    throw new Error('invalid encrypted value');
  }
  const signed = decoded.subarray(0, -32);
  const actualSignature = decoded.subarray(-32);
  const expectedSignature = createHmac('sha256', Buffer.from(key.subarray(0, 16)))
    .update(signed)
    .digest();
  if (!timingSafeEqual(actualSignature, expectedSignature)) {
    throw new Error('invalid encrypted value');
  }
  const iv = decoded.subarray(9, 25);
  const ciphertext = decoded.subarray(25, -32);
  try {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key.subarray(16)), iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('invalid encrypted value');
  }
}

function storageKey(collection: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(collection) || collection.length > 80) {
    throw new Error('invalid storage collection');
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(id) || id.length > 512) {
    throw new Error('invalid storage key');
  }
  return `jupyter-collab-mcp:${collection}:${id}`;
}

export class EncryptedStore {
  readonly #backend: KeyValueBackend;
  readonly #key: Uint8Array;
  readonly #now: () => number;

  constructor(backend: KeyValueBackend, key: Uint8Array, now: () => number = Date.now) {
    if (key.byteLength !== 32) throw new Error('encryption key must contain 32 bytes');
    this.#backend = backend;
    this.#key = new Uint8Array(key);
    this.#now = now;
  }

  async put(
    collection: string,
    id: string,
    value: unknown,
    ttlSeconds?: number
  ): Promise<void> {
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      throw new Error('storage TTL must be positive');
    }
    const encrypted = encryptValue(JSON.stringify(value), this.#key, this.#now);
    await this.#backend.set(
      storageKey(collection, id),
      encrypted,
      ttlSeconds === undefined ? undefined : Math.max(1, Math.ceil(ttlSeconds))
    );
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const encrypted = await this.#backend.get(storageKey(collection, id));
    if (encrypted === null) return null;
    try {
      return JSON.parse(decryptValue(encrypted, this.#key)) as T;
    } catch {
      return null;
    }
  }

  async take<T>(collection: string, id: string): Promise<T | null> {
    const encrypted = await this.#backend.take(storageKey(collection, id));
    if (encrypted === null) return null;
    try {
      return JSON.parse(decryptValue(encrypted, this.#key)) as T;
    } catch {
      return null;
    }
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.#backend.delete(storageKey(collection, id));
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}

export class MemoryKeyValueBackend implements KeyValueBackend {
  readonly values = new Map<string, { value: string; expiresAt?: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(key: string): Promise<string | null> {
    const found = this.values.get(key);
    if (found === undefined) return null;
    if (found.expiresAt !== undefined && found.expiresAt <= this.#now()) {
      this.values.delete(key);
      return null;
    }
    return found.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.values.set(key, {
      value,
      ...(ttlSeconds === undefined ? {} : { expiresAt: this.#now() + ttlSeconds * 1000 })
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async take(key: string): Promise<string | null> {
    const found = this.values.get(key);
    this.values.delete(key);
    if (found === undefined) return null;
    if (found.expiresAt !== undefined && found.expiresAt <= this.#now()) return null;
    return found.value;
  }

  async close(): Promise<void> {}
}

export async function createEncryptedRedisStore(
  redisUrl: URL,
  key: Uint8Array,
  now: () => number = Date.now,
  onerror: (error: Error) => void = () => undefined
): Promise<EncryptedStore> {
  const client = redisUrl.protocol === 'unix:'
    ? createClient({
        socket: { path: redisUrl.pathname, tls: false },
        database: Number(redisUrl.searchParams.get('db') ?? '0')
      })
    : createClient({ url: redisUrl.href });
  client.on('error', onerror);
  await client.connect();
  const backend: KeyValueBackend = {
    get: async (storageName) => client.get(storageName),
    set: async (storageName, value, ttlSeconds) => {
      if (ttlSeconds === undefined) await client.set(storageName, value);
      else await client.set(storageName, value, { expiration: { type: 'EX', value: ttlSeconds } });
    },
    delete: async (storageName) => {
      await client.del(storageName);
    },
    take: async (storageName) => client.getDel(storageName),
    close: async () => {
      await client.close();
    }
  };
  return new EncryptedStore(backend, key, now);
}
