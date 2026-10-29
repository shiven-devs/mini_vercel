export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <span className="mb-12 font-mono text-sm text-muted">▲ deploy</span>
      {children}
    </main>
  );
}
