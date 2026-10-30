import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="centered">
      <div className="panel narrow">
        <h1>Page not found</h1>
        <p className="muted">The address may be mistyped, or the page has moved.</p>
        <Link className="button" href="/dashboard">
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
