"use client"; // Error boundaries must be Client Components
import Link from "next/link";

/** Generic message only: server error details are never forwarded to the browser. */
export default function RootError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="page-heading">
      <p className="eyebrow">Something went wrong</p>
      <h1>This page could not be loaded</h1>
      <p>
        A temporary problem prevented this page from loading. Please try again.
      </p>
      <p>
        <button type="button" className="reset-button" onClick={() => retry()}>
          Try again
        </button>{" "}
        · <Link href="/">Home</Link> · <Link href="/players">Players</Link>
      </p>
    </div>
  );
}
