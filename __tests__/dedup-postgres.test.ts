/** @jest-environment node */
import { createFingerprintTable, reserveFingerprint, withReservation,
  forgetFingerprintUrl, registerLegacyFingerprint,
  filterConfirmedUploads } from '@/photo/dedup/query';
import { finishUploadAction, cancelUploadAction,
  reserveUploadAction } from '@/photo/dedup/actions';
import { query } from '@/platforms/postgres';
import { runAuthenticatedAdminServerAction } from '@/auth/server';
import { copyFile, deleteFile } from '@/platforms/storage';
import { commitPhotoUpload } from '@/photo/dedup/storage';

// Explicit opt-in only; never connects to the application's POSTGRES_URL.
jest.mock('@/platforms/postgres', () => {
  const { Pool } = jest.requireActual('pg');
  const connectionString = process.env.DEDUP_TEST_DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/dedup_test') {
      throw new Error('Use isolated test DB');
    }
  }
  const pool = connectionString ? new Pool({ connectionString }) : null;
  return {
    query: (sql: string, args: unknown[]) => pool.query(sql, args),
    withTransaction: async (
      callback: (client: unknown) => Promise<unknown>,
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    closeTestPool: () => pool?.end(),
  };
});
jest.mock('@/auth/server', () => ({
  runAuthenticatedAdminServerAction: jest.fn(
    (callback: () => unknown) => callback(),
  ),
}));
jest.mock('@/app/config', () => ({ CURRENT_STORAGE: 'minio' }));
jest.mock('@/platforms/storage', () => ({
  baseUrlForStorage: () => 'https://storage.test',
  getSignedUrlForUrl: (url: string) => url,
  copyFile: jest.fn(), deleteFile: jest.fn(),
}));

const suite = process.env.DEDUP_TEST_DATABASE_URL ? describe : describe.skip;
suite('PostgreSQL fingerprint lifecycle', () => {
  const hash = 'a'.repeat(64);
  const originalFetch = global.fetch;
  beforeAll(async () => { await createFingerprintTable(); });
  beforeEach(async () => {
    await query('TRUNCATE photo_fingerprints');
    jest.mocked(copyFile).mockImplementation(async (_from, to) =>
      `https://storage.test/${to}`);
    jest.mocked(deleteFile).mockResolvedValue(undefined);
    global.fetch = jest.fn(async url => new Response('', {
      status: String(url).includes('/pending-') ? 200 : 404,
    }));
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    const db = jest.requireMock('@/platforms/postgres');
    await db.closeTestPool();
  });

  it('allows only one of 12 simultaneous reservations', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => reserveFingerprint(hash)),
    );
    expect(tokens.filter(Boolean)).toHaveLength(1);
  });

  it('allows different content concurrently', async () => {
    expect(await reserveFingerprint(hash)).toBeTruthy();
    expect(await reserveFingerprint('b'.repeat(64))).toBeTruthy();
  });

  it('completes idempotently and retains the published index', async () => {
    const token = (await reserveFingerprint(hash))!;
    const url = await finishUploadAction(hash, token, 'jpg');
    expect(await finishUploadAction(hash, token, 'jpg')).toBe(url);
    expect(await cancelUploadAction(hash, token, 'jpg')).toBe(url);
    await commitPhotoUpload(url, 'https://storage.test/photo-published.jpg');
    expect(await reserveFingerprint(hash)).toBeNull();
    await forgetFingerprintUrl('https://storage.test/photo-published.jpg');
    expect(await reserveFingerprint(hash)).toBeTruthy();
  });

  it('releases failed uploads immediately', async () => {
    const token = (await reserveFingerprint(hash))!;
    expect(await cancelUploadAction(hash, token, 'jpg')).toBeNull();
    expect(await reserveFingerprint(hash)).toBeTruthy();
  });

  it('does not release a lease when storage deletion fails', async () => {
    const token = (await reserveFingerprint(hash))!;
    jest.mocked(deleteFile).mockRejectedValueOnce(new Error('storage offline'));
    await expect(cancelUploadAction(hash, token, 'jpg')).rejects.toThrow();
    expect(await reserveFingerprint(hash)).toBeNull();
  });

  it('reclaims stale leases and fences old requests', async () => {
    const old = (await reserveFingerprint(hash))!;
    await query(`
      UPDATE photo_fingerprints SET expires_at = NOW() - INTERVAL '1 hour'
    `);
    const fresh = (await reserveFingerprint(hash))!;
    expect(fresh).not.toBe(old);
    await expect(finishUploadAction(hash, old, 'jpg'))
      .rejects.toThrow('expired');
    await expect(cancelUploadAction(hash, old, 'jpg'))
      .rejects.toThrow('expired');
    expect(await reserveFingerprint(hash)).toBeNull();
  });

  it('row locking fences lease replacement during finalization', async () => {
    const token = (await reserveFingerprint(hash))!;
    await query(`
      UPDATE photo_fingerprints SET expires_at = NOW() - INTERVAL '1 hour'
    `);
    let unlock!: () => void;
    let locked!: () => void;
    const lockAcquired = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { unlock = resolve; });
    const complete = withReservation(hash, token, async client => {
      locked();
      await hold;
      await client.query(`
        UPDATE photo_fingerprints SET urls = ARRAY['saved']
      `);
    });
    await lockAcquired;
    const contender = reserveFingerprint(hash);
    unlock();
    await complete;
    expect(await contender).toBeNull();
  });

  it('keeps legacy copies indexed until the last deletion', async () => {
    expect(await registerLegacyFingerprint(hash, 'first')).toBe(false);
    expect(await registerLegacyFingerprint(hash, 'second')).toBe(true);
    await registerLegacyFingerprint(hash, 'second');
    const { rows } = await query('SELECT urls FROM photo_fingerprints');
    expect(rows[0].urls.sort()).toEqual(['first', 'second']);
    await forgetFingerprintUrl('first');
    expect(await reserveFingerprint(hash)).toBeNull();
    await forgetFingerprintUrl('second');
    expect(await reserveFingerprint(hash)).toBeTruthy();
  });

  it('hides uncommitted copies from the pending-upload list', async () => {
    const token = (await reserveFingerprint(hash))!;
    const url = `https://storage.test/upload-${token}.jpg`;
    expect(await filterConfirmedUploads([{ url }])).toEqual([]);
    await finishUploadAction(hash, token, 'jpg');
    expect(await filterConfirmedUploads([{ url }])).toEqual([{ url }]);
  });

  it('requires authentication even for hash lookups', async () => {
    jest.mocked(runAuthenticatedAdminServerAction).mockRejectedValueOnce(
      new Error('Unauthorized'),
    );
    await expect(reserveUploadAction(hash)).rejects.toThrow('Unauthorized');
  });
});
