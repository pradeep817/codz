'use client';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="centered">
      <div className="panel narrow">
        <h1>Something went wrong</h1>
        <p className="muted">The page could not load. Try again; if it keeps happening, check the server logs.</p>
        <button className="button" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
