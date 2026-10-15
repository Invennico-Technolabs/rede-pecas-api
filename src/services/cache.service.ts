import { createClient } from 'redis';
import { config } from '../config/config.js';
import { logger } from '../config/logger.js';

/**
 * Shared Redis-with-in-memory-fallback key/value store backing every session
 * flag/offer/cache in session.service.ts. Every write goes to an in-memory
 * mirror AND Redis (when connected); every read prefers Redis and falls back
 * to the mirror when Redis is down or the call errors — so a Redis outage
 * degrades to per-process memory instead of breaking the conversation flow.
 *
 * Memory entries are stored as the same serialized string Redis holds (not
 * live object references) and carry their own expiry, so fallback mode
 * behaves like Redis: values expire on the same TTL, and a caller mutating a
 * returned object can't silently change what's cached.
 */

export const SESSION_TTL = 60 * 60 * 4;

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
const memory = new Map<string, { value: string; expiresAt: number }>();

// How long boot waits for the first Redis connection before starting in
// memory-fallback mode. node-redis v4 retries forever and its connect()
// promise never settles while Redis is unreachable, so an unbounded await
// would stop the server from ever listening.
const REDIS_BOOT_TIMEOUT_MS = 5000;

// Right after process start, Redis isn't ready for the whole span of the
// connect() attempt, which looks IDENTICAL to "Redis is down" even though
// Redis is about to come up and already holds real session data (e.g. a
// customer's detected locale) from before this restart. A request handled
// in that window would read the fresh, empty in-memory map instead — this
// once caused a courtesy message to go out in both the customer's actual
// (Redis-cached) locale and DEFAULT_LOCALE within the same minute after a
// dev-server hot-reload. `redisReady` lets `index.ts` hold off starting the
// HTTP server / background sweeps until the attempt settles (or times out).
export let redisReady: Promise<void> = Promise.resolve();

if (config.redis.url) {
  try {
    redisClient = createClient({ url: config.redis.url });

    // The client emits 'error' on every failed reconnect attempt (many per
    // second) — log once per outage, and once more when it recovers.
    let outageLogged = false;
    redisClient.on('error', (err: unknown) => {
      if (outageLogged) return;
      outageLogged = true;
      logger.error('Redis unavailable, using in-memory cache until it reconnects', err);
    });
    redisClient.on('ready', () => {
      if (outageLogged) logger.info('Redis connection restored');
      outageLogged = false;
    });

    const connected = redisClient.connect().then(() => {
      logger.info('Connected to Redis successfully for sessions');
    }).catch((err: unknown) => {
      logger.error('Failed to connect to Redis, using memory fallback', err);
    });
    const timedOut = new Promise<void>((resolve) => setTimeout(() => {
      if (!redisClient?.isReady) {
        logger.warn(`Redis not reachable within ${REDIS_BOOT_TIMEOUT_MS}ms — starting with in-memory cache, will keep retrying`);
      }
      resolve();
    }, REDIS_BOOT_TIMEOUT_MS).unref());
    redisReady = Promise.race([connected, timedOut]);
  } catch (err) {
    logger.error('Failed to initialize Redis client, using memory fallback', err);
    redisClient = null;
  }
} else {
  logger.info('No REDIS_URL provided, using in-memory cache for sessions');
}

/**
 * Reports whether Redis is usable right now. Uses the live `isReady` state
 * (not `isOpen`, which stays true while the client is reconnecting), so the
 * store switches back to Redis automatically once it recovers.
 */
function redisAvailable(): boolean {
  return !!redisClient?.isReady;
}

/**
 * Reads a live (non-expired) entry from the in-memory mirror, evicting it
 * lazily if it has expired.
 */
function readMemory(key: string): string | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Runs `redisOp` when Redis is available, otherwise (or if it throws)
 * returns `fallback()`. The single place the Redis-vs-memory decision and
 * error logging live.
 */
async function withRedis<T>(action: string, key: string, redisOp: (client: RedisClient) => Promise<T>, fallback: () => T): Promise<T> {
  if (!redisAvailable()) return fallback();
  try {
    return await redisOp(redisClient as RedisClient);
  } catch (err) {
    logger.error(`Redis error while ${action} ${key}`, err);
    return fallback();
  }
}

/**
 * Stores a raw string under `key` for `ttlSeconds`.
 */
export async function setString(key: string, value: string, ttlSeconds: number = SESSION_TTL): Promise<void> {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  await withRedis('saving', key, (c) => c.setEx(key, ttlSeconds, value), () => undefined);
}

/**
 * Reads a raw string by `key`, or null if absent/expired.
 */
export async function getString(key: string): Promise<string | null> {
  return withRedis('fetching', key, async (c) => (await c.get(key)) ?? null, () => readMemory(key));
}

/**
 * Stores a JSON-serializable value under `key` for `ttlSeconds`.
 */
export async function setJSON<T>(key: string, value: T, ttlSeconds: number = SESSION_TTL): Promise<void> {
  await setString(key, JSON.stringify(value), ttlSeconds);
}

/**
 * Reads and parses a JSON value by `key`, or null if absent/expired/corrupt.
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const raw = await getString(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.error(`Corrupt JSON in cache key ${key}`, err);
    return null;
  }
}

/**
 * Sets a presence-only flag under `key` for `ttlSeconds`.
 */
export async function setFlag(key: string, ttlSeconds: number = SESSION_TTL): Promise<void> {
  await setString(key, '1', ttlSeconds);
}

/**
 * Reports whether a flag (or any value) currently exists under `key`.
 */
export async function hasKey(key: string): Promise<boolean> {
  return withRedis('checking', key, async (c) => (await c.exists(key)) === 1, () => readMemory(key) !== null);
}

/**
 * Atomically claims `key` for `ttlSeconds` if nobody holds it yet (Redis
 * `SET NX`). Returns true only for the first caller — used for idempotency
 * (e.g. dropping duplicate webhook deliveries).
 */
export async function claimKey(key: string, ttlSeconds: number): Promise<boolean> {
  const claimInMemory = () => {
    if (readMemory(key) !== null) return false;
    memory.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  };
  return withRedis('claiming', key, async (c) => (await c.set(key, '1', { NX: true, EX: ttlSeconds })) === 'OK', claimInMemory);
}

/**
 * Returns the remaining TTL in seconds for `key`, or a negative number if
 * it's missing (-2) or has no expiry (-1) — mirroring Redis' TTL semantics.
 */
export async function getTTL(key: string): Promise<number> {
  const fromMemory = () => {
    const entry = memory.get(key);
    if (!entry || entry.expiresAt < Date.now()) return -2;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  };
  return withRedis('reading TTL of', key, (c) => c.ttl(key), fromMemory);
}

/**
 * Overwrites a string value without changing its existing expiry. Falls
 * back to `fallbackTtlSeconds` if the key has no live expiry to keep.
 */
export async function setStringKeepTTL(key: string, value: string, fallbackTtlSeconds: number = SESSION_TTL): Promise<void> {
  const existing = memory.get(key);
  const expiresAt = existing && existing.expiresAt >= Date.now()
    ? existing.expiresAt
    : Date.now() + fallbackTtlSeconds * 1000;
  memory.set(key, { value, expiresAt });
  await withRedis('saving', key, (c) => c.set(key, value, { KEEPTTL: true }), () => undefined);
}

/**
 * Deletes `key` from both the memory mirror and Redis.
 */
export async function deleteKey(key: string): Promise<void> {
  memory.delete(key);
  await withRedis('deleting', key, (c) => c.del(key), () => undefined);
}

/**
 * Deletes every key starting with `prefix` from both stores. Uses SCAN
 * (not KEYS) so it doesn't block Redis on a large keyspace.
 */
export async function deleteByPrefix(prefix: string): Promise<void> {
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  await withRedis('deleting keys matching', `${prefix}*`, async (c) => {
    for await (const key of c.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      await c.del(key);
    }
  }, () => undefined);
}
