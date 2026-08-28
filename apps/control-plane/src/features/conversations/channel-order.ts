const prefix = "communicator:channel-order";

function key(principalId: string, identityId: string) {
  return `${prefix}:${principalId}:${identityId}`;
}

export function loadChannelOrder(principalId: string, identityId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key(principalId, identityId)) ?? "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? [...new Set(parsed)]
      : [];
  } catch {
    return [];
  }
}

export function saveChannelOrder(principalId: string, identityId: string, ids: string[]) {
  sessionStorage.setItem(key(principalId, identityId), JSON.stringify([...new Set(ids)]));
}

export function clearChannelOrderPreferences() {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const item = sessionStorage.key(index);
    if (item?.startsWith(`${prefix}:`)) sessionStorage.removeItem(item);
  }
}

export function applyChannelOrder<T extends { id: string; sort_position: number }>(
  channels: T[],
  preferredIds: string[],
): T[] {
  const preferred = new Map(preferredIds.map((id, index) => [id, index]));
  return channels.toSorted((left, right) => {
    const leftIndex = preferred.get(left.id);
    const rightIndex = preferred.get(right.id);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return left.sort_position - right.sort_position || left.id.localeCompare(right.id);
  });
}

export function moveChannel(ids: string[], id: string, direction: -1 | 1) {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  const fromId = next[from];
  const toId = next[to];
  if (fromId === undefined || toId === undefined) return ids;
  next[from] = toId;
  next[to] = fromId;
  return next;
}
