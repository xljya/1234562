/** @jest-environment node */
import { File } from 'node:buffer';
import { hashFile, prepareUpload, uploadReservedFile,
  DuplicateUploadError } from '@/photo/dedup/client';
import { reserveUploadAction, finishUploadAction,
  cancelUploadAction } from '@/photo/dedup/actions';
import { uploadFileFromClient } from '@/platforms/storage';

jest.mock('@/photo/dedup/actions', () => ({
  reserveUploadAction: jest.fn(), finishUploadAction: jest.fn(),
  cancelUploadAction: jest.fn(),
}));
jest.mock('@/platforms/storage', () => ({ uploadFileFromClient: jest.fn() }));

describe('original-file deduplication', () => {
  beforeEach(() => jest.resetAllMocks());

  it('uses content, not filename, and produces SHA-256', async () => {
    const first = new File(['abc'], 'one.jpg');
    const renamed = new File(['abc'], 'renamed.png');
    expect(await hashFile(first)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await hashFile(first)).toBe(await hashFile(renamed));
    expect(await hashFile(new File(['different'], 'one.jpg')))
      .not.toBe(await hashFile(first));
  });

  it('rejects a duplicate before any storage upload', async () => {
    jest.mocked(reserveUploadAction).mockResolvedValue(null);
    await expect(prepareUpload(new File(['abc'], 'one.jpg')))
      .rejects.toBeInstanceOf(DuplicateUploadError);
    expect(uploadFileFromClient).not.toHaveBeenCalled();
  });

  it('releases the reservation after an upload failure', async () => {
    jest.mocked(uploadFileFromClient).mockRejectedValue(new Error('network'));
    jest.mocked(cancelUploadAction).mockResolvedValue(null);
    await expect(uploadReservedFile({ hash: 'hash', token: 'token' },
      new File(['abc'], 'one.jpg'), 'jpg')).rejects.toThrow('network');
    expect(cancelUploadAction).toHaveBeenCalledWith('hash', 'token', 'jpg');
    expect(finishUploadAction).not.toHaveBeenCalled();
  });

  it('recovers a committed upload whose response was lost', async () => {
    jest.mocked(uploadFileFromClient).mockResolvedValue('staging');
    jest.mocked(finishUploadAction).mockRejectedValue(
      new Error('response lost'),
    );
    jest.mocked(cancelUploadAction).mockResolvedValue('saved-photo');
    await expect(uploadReservedFile({ hash: 'hash', token: 'token' },
      new File(['abc'], 'one.jpg'), 'jpg')).resolves.toBe('saved-photo');
  });
});
