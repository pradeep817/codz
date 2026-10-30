'use client';

import { useActionState } from 'react';

import { updateProfile, type FormState } from '@/lib/auth/actions';
import type { User } from '@/types/user';

export default function ProfileForm({ user }: { user: User }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, {});
  return (
    <form action={action} className="form">
      <label>
        Name
        <input name="name" defaultValue={user.name} autoComplete="name" required />
      </label>
      <label>
        Email
        <input value={user.email} disabled />
      </label>
      {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      {state.saved ? <p className="success" role="status">Saved.</p> : null}
      <button className="button" disabled={pending}>
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
