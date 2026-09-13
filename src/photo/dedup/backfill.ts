'use server';

import { createHash } from 'node:crypto';
import { runAuthenticatedAdminServerAction } from '@/auth/server';
import { query } from '@/platforms/postgres';
import {
  getSignedUrlForUrl, getStorageUrlsForPrefix,
} from '@/platforms/storage';
import { ensureFingerprintTable, registerLegacyFingerprint,
  filterConfirmedUploads, withFingerprintUrlLock } from './query';
import { MAX_PHOTO_UPLOAD_SIZE_IN_BYTES } from '@/photo';

export const getBackfillUrlsAction = async () =>
  runAuthenticatedAdminServerAction(async () => {
    const [{ rows }, uploads] = await Promise.all([
      query('SELECT url FROM photos'),
      getStorageUrlsForPrefix('upload-', true).then(filterConfirmedUploads),
    ]);
    await ensureFingerprintTable();
    const indexed = await query(
      'SELECT unnest(urls) AS url FROM photo_fingerprints',
    );
    const known = new Set(indexed.rows.map(row => row.url));
    return [...new Set<string>([
      ...rows.map(row => row.url), ...uploads.map(upload => upload.url),
    ])].filter(url => !known.has(url));
  });

export const backfillPhotoAction = async (url: string) =>
  runAuthenticatedAdminServerAction(async () => {
    // Accept only a real existing photo/upload, never an arbitrary fetch URL.
    const photo = await query('SELECT 1 FROM photos WHERE url = $1', [url]);
    if (!photo.rows.length) {
      const uploads = await getStorageUrlsForPrefix('upload-', true)
        .then(filterConfirmedUploads);
      if (!uploads.some(upload => upload.url === url)) {
        throw new Error('Photo no longer exists');
      }
    }
    const response = await fetch(await getSignedUrlForUrl(url, 'GET'), {
      cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok || !response.body) {
      throw new Error('Cannot read photo');
    }
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        size += value.length;
        if (size > MAX_PHOTO_UPLOAD_SIZE_IN_BYTES) {
          throw new Error('Photo exceeds indexing size limit');
        }
        hash.update(value);
      }
    } finally {
      await reader.cancel();
    }
    return withFingerprintUrlLock(url, async client => {
      // Recheck after reading: deletion/publication may have run meanwhile.
      const current = await client.query(
        'SELECT 1 FROM photos WHERE url = $1', [url],
      );
      if (!current.rows.length) {
        const uploads = await getStorageUrlsForPrefix('upload-', true);
        if (!uploads.some(upload => upload.url === url)) {
          throw new Error('Photo was removed during indexing');
        }
      }
      return registerLegacyFingerprint(hash.digest('hex'), url, client);
    });
  });
