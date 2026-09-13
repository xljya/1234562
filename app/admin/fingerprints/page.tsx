import { runAuthenticatedAdminServerAction } from '@/auth/server';
import AppGrid from '@/components/AppGrid';
import BackfillClient from '@/photo/dedup/BackfillClient';

export const maxDuration = 60;

export default async function FingerprintsPage() {
  await runAuthenticatedAdminServerAction(() => true);
  return <AppGrid contentMain={<BackfillClient />} />;
}
