"use client"; // Error boundaries must be Client Components
import Link from "next/link";

/** Generic message only: server error details are not forwarded to the browser in production. */
export default function PlayersError({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <div className="page-heading">
      <h1>Player data could not be loaded</h1>
      <p>Something went wrong while reading AFL data. Please try again.</p>
      <p>
        <button type="button" className="reset-button" onClick={() => retry()}>
          Try again
        </button>{" "}
        <Link href="/">Back to home</Link>
      </p>
    </div>
  );
}
