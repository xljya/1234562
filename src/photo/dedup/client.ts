import { reserveUploadAction, finishUploadAction,
  cancelUploadAction } from './actions';
import { uploadFileFromClient } from '@/platforms/storage';

export class DuplicateUploadError extends Error {
  constructor() { super('Duplicate upload'); }
}

export const hashFile = async (file: Blob) => {
  const digest = await crypto.subtle.digest(
    'SHA-256', await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')).join('');
};

export const prepareUpload = async (file: File) => {
  const hash = await hashFile(file);
  const token = await reserveUploadAction(hash);
  if (!token) { throw new DuplicateUploadError(); }
  return { hash, token };
};

export const uploadReservedFile = async (
  reservation: Awaited<ReturnType<typeof prepareUpload>>,
  blob: Blob,
  extension = 'jpg',
) => {
  const { hash, token } = reservation;
  try {
    await uploadFileFromClient(blob, `pending-${token}`, extension, false);
    return await finishUploadAction(hash, token, extension);
  } catch (error) {
    // Cleanup is server-fenced: an old attempt cannot release a newer lease.
    const recovered = await cancelUploadAction(hash, token, extension)
      .catch(() => null);
    if (recovered) { return recovered; }
    throw error;
  }
};
