const DEFAULT_LIMIT = 1600;

export function splitMessage(text: string, limit = DEFAULT_LIMIT): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const breakAt =
      lastIndex(window, "\n\n") ||
      lastIndex(window, "\n") ||
      lastIndex(window, ". ") ||
      lastIndex(window, " ");
    const end = breakAt > limit * 0.4 ? breakAt : limit;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function lastIndex(value: string, token: string): number {
  const index = value.lastIndexOf(token);
  return index === -1 ? 0 : index + token.length;
}
