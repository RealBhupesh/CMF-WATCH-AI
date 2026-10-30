export function parseOptOuts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function normalizeOptOuts(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 200) break;
  }
  return out;
}

export function isOptedOut(sender: string, optOuts: string[]): boolean {
  const target = sender.trim().toLowerCase();
  if (!target) return false;
  return optOuts.some((item) => item.trim().toLowerCase() === target);
}
