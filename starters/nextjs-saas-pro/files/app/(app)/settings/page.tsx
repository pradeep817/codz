import type { Metadata } from 'next';

import ProfileForm from '@/components/ProfileForm';
import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <>
      <h1>Settings</h1>
      <section className="panel">
        <h2>Profile</h2>
        <ProfileForm user={user} />
      </section>
    </>
  );
}
