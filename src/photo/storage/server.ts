import {
  copyFile,
  deleteFile,
  getFileNamePartsFromStorageUrl,
  putFile,
} from '@/platforms/storage';
import {
  fetchImageUrlSafely,
  removeGpsData,
  resizeImageToBytes,
} from '../server';
import {
  generateRandomFileNameForPhoto,
  getOptimizedPhotoFileMeta,
} from '.';
import { linkFingerprintUrl, forgetFingerprintUrl } from '../dedup/query';

export const storeOptimizedPhotosForUrl = async (
  url: string,
  _fileBytes?: ArrayBuffer,
) => {
  const fileBytes = _fileBytes
    ? _fileBytes
    : await fetchImageUrlSafely(url);
  const { fileNameBase } = getFileNamePartsFromStorageUrl(url);
  const optimizedPhotoFileMeta = getOptimizedPhotoFileMeta(fileNameBase);
  for (const { fileName, size, quality } of optimizedPhotoFileMeta) {
    await putFile(await resizeImageToBytes(fileBytes, size, quality), fileName);
  }
  return url;
};

export const convertUploadToPhoto = async ({
  uploadUrl,
  fileBytes: _fileBytes,
  shouldStripGpsData,
  shouldDeleteOrigin = false,
} : {
  uploadUrl: string
  fileBytes?: ArrayBuffer
  shouldStripGpsData?: boolean
  shouldDeleteOrigin?: boolean
}) => {
  const fileNameBase = generateRandomFileNameForPhoto();
  const { fileExtension } = getFileNamePartsFromStorageUrl(uploadUrl);
  const fileName = `${fileNameBase}.${fileExtension}`;
  const fileBytes = _fileBytes
    ? _fileBytes
    : await fetchImageUrlSafely(uploadUrl);
  const updatedUrl = shouldStripGpsData
    ? await putFile(await removeGpsData(fileBytes), fileName)
    : await copyFile(uploadUrl, fileName);
  // Callers retain the origin until their database write succeeds.
  await storeOptimizedPhotosForUrl(updatedUrl, fileBytes);
  if (shouldDeleteOrigin) {
    await linkFingerprintUrl(uploadUrl, updatedUrl);
    await deleteFile(uploadUrl);
    await forgetFingerprintUrl(uploadUrl);
  }

  return updatedUrl;
};
