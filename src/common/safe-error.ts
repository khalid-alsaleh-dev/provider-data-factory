/** Error text that is safe to log or persist: connection URLs (which may hold credentials) are removed. */
export function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  return `${error.name}: ${error.message}`
    .replace(/(?:mongodb(?:\+srv)?|rediss?|https?):\/\/\S+/gi, '[redacted-url]')
    .slice(0, 500);
}
