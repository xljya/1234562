'use client';

import { useRef, useState } from 'react';
import { useAppText } from '@/i18n/state/client';
import { backfillPhotoAction, getBackfillUrlsAction } from './backfill';

export default function BackfillClient() {
  const { admin: text } = useAppText();
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({
    done: 0, total: 0, duplicate: 0, failed: 0,
  });
  const run = async (retry?: string[]) => {
    if (busy.current) { return; }
    busy.current = true;
    setRunning(true);
    setError('');
    try {
      const urls = retry ?? await getBackfillUrlsAction();
      const counts = { done: 0, total: urls.length, duplicate: 0, failed: 0 };
      const failures: string[] = [];
      setProgress({ ...counts });
      for (const url of urls) {
        try { if (await backfillPhotoAction(url)) { counts.duplicate++; } }
        catch { failures.push(url); counts.failed++; }
        counts.done++;
        setProgress({ ...counts });
      }
      setFailedUrls(failures);
    } catch {
      setError(text.uploadFailed);
    } finally {
      setRunning(false);
      busy.current = false;
    }
  };
  return <section className="space-y-4">
    <h1>{text.fingerprintTitle}</h1>
    <p>{text.fingerprintDescription}</p>
    <button disabled={running} onClick={() => run()}>
      {text.fingerprintStart}
    </button>
    {failedUrls.length > 0 && <button
      disabled={running}
      onClick={() => run(failedUrls)}
    >{text.fingerprintRetry}</button>}
    <p role="status" aria-live="polite">
      {text.fingerprintProgress
        .replace('{{done}}', String(progress.done))
        .replace('{{total}}', String(progress.total))
        .replace('{{duplicate}}', String(progress.duplicate))
        .replace('{{failed}}', String(progress.failed))}
    </p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
