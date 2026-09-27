/** Defense-in-depth: strip known secrets out of anything about to be printed or persisted. */
export function makeRedactor(secrets: (string | undefined)[]) {
  const values = secrets.filter((s): s is string => !!s && s.length > 0);
  return (input: string): string => {
    let out = input;
    for (const secret of values) {
      out = out.split(secret).join("[REDACTED]");
    }
    return out;
  };
}
