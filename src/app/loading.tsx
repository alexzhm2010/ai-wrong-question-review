export default function Loading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-5 w-44 animate-pulse rounded bg-muted" />
            <div className="h-3 w-64 animate-pulse rounded bg-muted" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="mb-2 h-3 w-full animate-pulse rounded bg-muted" />
              <div className="mb-4 h-3 w-4/5 animate-pulse rounded bg-muted" />
              <div className="flex gap-2">
                <div className="h-6 w-16 animate-pulse rounded-full bg-muted" />
                <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
