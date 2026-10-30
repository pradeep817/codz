'use client';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <p>Could not load this page: {error.message}</p>
      <button onClick={() => reset()}>Retry</button>
    </main>
  );
}
