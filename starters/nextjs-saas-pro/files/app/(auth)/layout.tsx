export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="centered">
      <div className="panel narrow">
        <p className="brand">{'{{appTitle}}'}</p>
        {children}
      </div>
    </main>
  );
}
