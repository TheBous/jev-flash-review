export function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Missing or malformed judge answers are a broken judge contract. */
export function need<T>(map: Record<string, T>, key: string): T {
  const value = map[key];
  if (value === undefined) throw new Error(`Missing answer for question "${key}"`);
  return value;
}
