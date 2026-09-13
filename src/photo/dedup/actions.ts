'use server';

import { runAuthenticatedAdminServerAction } from '@/auth/server';
import { baseUrlForStorage, copyFile, deleteFile,
  getSignedUrlForUrl } from '@/platforms/storage';
import { CURRENT_STORAGE } from '@/app/config';
import { reserveFingerprint, withReservation } from './query';

export const reserveUploadAction = async (hash: string) =>
  runAuthenticatedAdminServerAction(() => reserveFingerprint(hash));

const uploadPaths = (token: string, extension: string) => {
  if (!/^[a-f0-9]{32}$/.test(token) ||
    !/^(jpg|jpeg|png|webp|avif|gif|heic|heif)$/i.test(extension)) {
    throw new Error('Invalid upload path');
  }
  const base = baseUrlForStorage(CURRENT_STORAGE);
  if (!base) { throw new Error('Storage is not configured'); }
  return {
    staging: `${base}/pending-${token}.${extension}`,
    destination: `upload-${token}.${extension}`,
    final: `${base}/upload-${token}.${extension}`,
  };
};

export const finishUploadAction = async (
  hash: string, token: string, extension: string,
) => runAuthenticatedAdminServerAction(async () => {
  const paths = uploadPaths(token, extension);
  const url = await withReservation(hash, token, async (client, urls) => {
    if (urls.length) { return urls[0]; } // Response-loss retry is idempotent.
    const exists = async (url: string) => {
      const response = await fetch(await getSignedUrlForUrl(url, 'GET'), {
        cache: 'no-store', signal: AbortSignal.timeout(30000),
        headers: { Range: 'bytes=0-0' },
      });
      await response.body?.cancel();
      if (response.status === 404) { return false; }
      if (!response.ok) { throw new Error('Cannot verify uploaded file'); }
      return true;
    };
    // Recover a copy completed before a process crash / transaction rollback.
    let destination = paths.final;
    if (!await exists(destination)) {
      if (!await exists(paths.staging)) {
        throw new Error('Uploaded file is not available');
      }
      destination = await copyFile(paths.staging, paths.destination);
    }
    await client.query(`
      UPDATE photo_fingerprints SET urls = ARRAY[$3]::text[]
      WHERE hash = $1 AND token = $2
    `, [hash, token, destination]);
    return destination;
  });
  // Staging objects are never shown in the uploads list.
  await deleteFile(paths.staging).catch(() => undefined);
  return url;
});

export const cancelUploadAction = async (
  hash: string, token: string, extension: string,
) => runAuthenticatedAdminServerAction(async () => {
  const paths = uploadPaths(token, extension);
  return withReservation(hash, token, async (client, urls) => {
    // Finalization may have succeeded even when the response was lost.
    if (urls.length) { return urls[0]; }
    await deleteFile(paths.staging);
    await deleteFile(paths.final);
    await client.query(`
      DELETE FROM photo_fingerprints WHERE hash = $1 AND token = $2
    `, [hash, token]);
    return null;
  });
});
