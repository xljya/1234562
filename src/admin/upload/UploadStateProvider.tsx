'use client';

import {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { UploadStateContext } from './UploadState';
import { INITIAL_UPLOAD_STATE, UploadBlobArgs, UploadState } from '.';
import { revalidateAdminAfterUploadAction } from '@/admin/actions';
import { PATH_ADMIN_UPLOADS, pathForAdminUploadUrl } from '@/app/path';
import { isAbortError } from '@/utility/abort';
import { useAppText } from '@/i18n/state/client';
import {
  DuplicateUploadError,
  prepareUpload,
  uploadReservedFile,
} from '@/photo/dedup/client';

export default function UploadStateProvider({
  children,
}: {
  children: ReactNode
}) {
  const router = useRouter();

  const pathname = usePathname();
  const appText = useAppText();

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [uploadState, _setUploadState] = useState(INITIAL_UPLOAD_STATE);
  const [hideUploadPanel, setHideUploadPanel] = useState(false);

  const startUpload = useCallback(() =>
    new Promise<boolean>(resolve => {
      if (uploadInputRef.current) {
        uploadInputRef.current.value = '';
        uploadInputRef.current.click();
        uploadInputRef.current.oninput = () => resolve(true);
        uploadInputRef.current.oncancel = () => resolve(false);
      } else {
        resolve(false);
      }
    })
  , []);
  const setUploadState = useCallback((uploadState: Partial<UploadState>) => {
    _setUploadState(prev => ({ ...prev, ...uploadState }));
  }, []);
  const resetUploadState = useCallback(() => {
    _setUploadState(INITIAL_UPLOAD_STATE);
  }, []);
  const startUploadSession = useCallback(() => {
    uploadAbortRef.current = new AbortController();
    return uploadAbortRef.current.signal;
  }, []);
  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    if (uploadInputRef.current) {
      uploadInputRef.current.value = '';
    }
    _setUploadState(INITIAL_UPLOAD_STATE);
  }, []);

  const shouldResetUploadStateAfterPending = useRef(false);
  const lastUploadedUrl = useRef<string | undefined>(undefined);
  const [isUploadPending, startUploadTransition] = useTransition();
  // Only reset upload state after route transition completes
  useEffect(() => {
    if (!isUploadPending && shouldResetUploadStateAfterPending.current) {
      resetUploadState();
      shouldResetUploadStateAfterPending.current = false;
    }
  }, [isUploadPending, resetUploadState]);
  const isFinishingUpload =
    isUploadPending && shouldResetUploadStateAfterPending.current;

  const onUploadStart = useCallback(() => {
    lastUploadedUrl.current = undefined;
    setUploadState({
      isUploading: true,
      uploadError: '',
      uploadProgress: 0,
    });
  }, [setUploadState]);
  const onUploadBlobReady = useCallback(async ({
    blob,
    extension,
    hasMultipleUploads,
    isLastBlob,
    abortSignal,
    onProgress,
  }: UploadBlobArgs) => {
    try {
      const reservation = await prepareUpload(blob);
      const url = await uploadReservedFile(
        reservation,
        blob,
        extension,
        { abortSignal, onProgress },
      );
      lastUploadedUrl.current = url;
      if (isLastBlob) {
        await revalidateAdminAfterUploadAction();
        shouldResetUploadStateAfterPending.current = true;
        if (pathname === PATH_ADMIN_UPLOADS) {
          setUploadState({ isUploading: false });
          router.refresh();
        } else {
          startUploadTransition(() => hasMultipleUploads
            ? router.push(PATH_ADMIN_UPLOADS)
            : router.push(pathForAdminUploadUrl(url)));
        }
      }
    } catch (error) {
      if (isAbortError(error)) { throw error; }
      console.error(error);
      setUploadState({
        isUploading: false,
        uploadError: error instanceof DuplicateUploadError
          ? appText.admin.uploadDuplicate
          : (error as Error).message,
      });
      if (isLastBlob && lastUploadedUrl.current) {
        shouldResetUploadStateAfterPending.current = true;
        if (pathname === PATH_ADMIN_UPLOADS) {
          router.refresh();
        } else {
          startUploadTransition(() => router.push(PATH_ADMIN_UPLOADS));
        }
      }
    }
  }
  , [appText.admin.uploadDuplicate, pathname, router, setUploadState]);

  return (
    <UploadStateContext
      value={{
        uploadInputRef,
        uploadState,
        setUploadState,
        resetUploadState,
        hideUploadPanel,
        setHideUploadPanel,
        startUpload,
        startUploadSession,
        cancelUpload,
        onUploadStart,
        onUploadBlobReady,
        isFinishingUpload,
      }}
    >
      {children}
    </UploadStateContext>
  );
}
