import { deleteFile } from '@/platforms/storage';
import { forgetFingerprintUrl, withFingerprintUrlLock,
  linkFingerprintUrl } from './query';

export const deleteTrackedFile = async (url: string) =>
  withFingerprintUrlLock(url, async client => {
    await deleteFile(url);
    await forgetFingerprintUrl(url, client);
  });

// Invoke only after the photo database insert/update has succeeded.
export const commitPhotoUpload = async (from: string, to: string) => {
  await linkFingerprintUrl(from, to);
  await deleteTrackedFile(from);
};
