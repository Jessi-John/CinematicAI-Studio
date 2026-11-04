"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled application error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="max-w-md text-center space-y-4 p-8">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          Something went wrong
        </h1>
        <p className="text-[var(--text-secondary)]">
          An unexpected error occurred. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="px-6 py-2 bg-[var(--accent-primary)] text-white rounded-lg hover:opacity-90 transition-opacity focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
