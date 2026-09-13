import { query, withTransaction } from '@/platforms/postgres';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

// Separate from photos: pending uploads and multiple legacy copies also count.
export const createFingerprintTable = () => withTransaction(async client => {
  // Serialize first-use DDL across multiple server workers.
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))', ['photo_fingerprints'],
  );
  return client.query(`
  CREATE TABLE IF NOT EXISTS photo_fingerprints (
    hash TEXT PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
    token TEXT NOT NULL,
    urls TEXT[] NOT NULL DEFAULT '{}',
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `);
});

let ready: Promise<unknown> | undefined;
export const ensureFingerprintTable = () => {
  ready ??= createFingerprintTable().catch(error => {
    ready = undefined;
    throw error;
  });
  return ready;
};

export const validateHash = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) { throw new Error('Invalid SHA-256'); }
};

export const reserveFingerprint = async (hash: string) => {
  validateHash(hash);
  await ensureFingerprintTable();
  const token = randomUUID().replaceAll('-', '');
  const result = await query(`
    INSERT INTO photo_fingerprints (hash, token, expires_at)
    VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
    ON CONFLICT (hash) DO UPDATE SET
      token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
    WHERE cardinality(photo_fingerprints.urls) = 0
      AND photo_fingerprints.expires_at < NOW()
    RETURNING token
  `, [hash, token]);
  return result.rows.length ? token : null;
};

export const withReservation = async <T>(
  hash: string,
  token: string,
  callback: (client: PoolClient, urls: string[]) => Promise<T>,
) => {
  validateHash(hash);
  if (!/^[a-f0-9]{32}$/.test(token)) { throw new Error('Invalid token'); }
  await ensureFingerprintTable();
  return withTransaction(async client => {
    const { rows } = await client.query(`
      SELECT urls FROM photo_fingerprints
      WHERE hash = $1 AND token = $2 FOR UPDATE
    `, [hash, token]);
    if (!rows[0]) { throw new Error('Upload reservation expired'); }
    // Row lock fences expired attempts against replacement by another browser.
    return callback(client, rows[0].urls as string[]);
  });
};

export const linkFingerprintUrl = async (from: string, to: string) => {
  await ensureFingerprintTable();
  await query(`
    UPDATE photo_fingerprints SET urls = array_append(urls, $2)
    WHERE $1 = ANY(urls) AND NOT ($2 = ANY(urls))
  `, [from, to]);
};

export const forgetFingerprintUrl = async (
  url: string, client?: PoolClient,
) => {
  await ensureFingerprintTable();
  // Keep an empty row immediately reclaimable, avoiding delete/insert races.
  const execute = client ? client.query.bind(client) : query;
  await execute(`
    UPDATE photo_fingerprints
    SET urls = array_remove(urls, $1), expires_at = NOW() - INTERVAL '1 second'
    WHERE $1 = ANY(urls)
  `, [url]);
};

export const withFingerprintUrlLock = async <T>(
  url: string, callback: (client: PoolClient) => Promise<T>,
) => {
  await ensureFingerprintTable();
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [url]);
    return callback(client);
  });
};

export const filterConfirmedUploads = async <T extends { url: string }>(
  uploads: T[],
): Promise<T[]> => {
  if (!uploads.some(({ url }) => /\/upload-[a-f0-9]{32}\./.test(url))) {
    return uploads;
  }
  await ensureFingerprintTable();
  const { rows } = await query(
    'SELECT unnest(urls) AS url FROM photo_fingerprints',
  );
  const confirmed = new Set(rows.map(row => row.url));
  return uploads.filter(({ url }) =>
    !/\/upload-[a-f0-9]{32}\./.test(url) || confirmed.has(url));
};

export const registerLegacyFingerprint = async (
  hash: string, url: string, client?: PoolClient,
) => {
  await ensureFingerprintTable();
  const execute = client ? client.query.bind(client) : query;
  const { rows } = await execute(`
    INSERT INTO photo_fingerprints (hash, token, urls)
    VALUES ($1, $2, ARRAY[$3]::text[])
    ON CONFLICT (hash) DO UPDATE SET urls = (
      SELECT ARRAY(SELECT DISTINCT unnest(
        photo_fingerprints.urls || EXCLUDED.urls
      ))
    )
    WHERE cardinality(photo_fingerprints.urls) > 0
      OR photo_fingerprints.expires_at < NOW()
    RETURNING cardinality(urls) AS copies
  `, [hash, randomUUID().replaceAll('-', ''), url]);
  if (!rows.length) { throw new Error('Upload in progress; retry backfill'); }
  return Number(rows[0].copies) > 1;
};
