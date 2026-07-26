/** Replaces every secret value with *** in any string reachable from `value`. */
export function makeMasker(secrets: Record<string, string>): (value: unknown) => unknown {
  const values = Object.values(secrets)
    .filter((v) => typeof v === "string" && v.length >= 4)
    .sort((a, b) => b.length - a.length);

  const maskString = (input: string): string =>
    values.reduce((acc, secret) => acc.split(secret).join("***"), input);

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return maskString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object" && Object.prototype.toString.call(value) !== "[object RegExp]") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return values.length ? walk : (value: unknown) => value;
}
