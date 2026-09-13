import { unstable_noStore } from 'next/cache';
import { filterConfirmedUploads } from '@/photo/dedup/query';
import {
  getStoragePhotoUrls,
  getStorageUploadUrls,
} from '@/photo/storage';

export const getStorageUploadUrlsNoStore: typeof getStorageUploadUrls =
  (...args) => {
    unstable_noStore();
    return getStorageUploadUrls(...args).then(filterConfirmedUploads);
  };

export const getStoragePhotoUrlsNoStore: typeof getStoragePhotoUrls =
  (...args) => {
    unstable_noStore();
    return getStoragePhotoUrls(...args);
  };
