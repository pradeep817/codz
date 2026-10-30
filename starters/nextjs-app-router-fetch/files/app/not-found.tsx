import Link from 'next/link';

export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>
        <Link href="/">Back to the home page</Link>
      </p>
    </main>
  );
}
