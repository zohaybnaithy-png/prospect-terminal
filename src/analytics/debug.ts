/**
 * The model-comparison view is a development/review tool. It is available in development, or in
 * a deployed build only when ANALYTICS_DEBUG=1 is set explicitly.
 */
export function analyticsDebugEnabled() {
  return (
    process.env.NODE_ENV !== "production" || process.env.ANALYTICS_DEBUG === "1"
  );
}
