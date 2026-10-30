'use client';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="panel">
      <h1>This page could not load</h1>
      <p className="muted">The API may be down or slow. Try again.</p>
      <button className="button" onClick={() => reset()}>
        Try again
      </button>
    </section>
  );
}
