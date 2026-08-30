/**
 * Who is holding these seats.
 *
 * `POST /reservations` requires a `holderId` UUID, and the API's DTO says why
 * it comes from the client for now: "Once authentication lands it comes from
 * the authenticated principal — a client must not be able to hold seats on
 * someone else's behalf." So this is a placeholder for a real identity, and it
 * is deliberately a thin one that can be deleted when auth arrives.
 *
 * Persisted in `localStorage` so a reload does not orphan a hold the user can
 * no longer prove is theirs.
 */
const STORAGE_KEY = 'event-ticketing.holder-id';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Insecure contexts do not expose randomUUID. The API only requires a UUID
  // shape, and this is an identity placeholder rather than a secret.
  return '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
}

export function holderId(): string {
  // Storage throws in some privacy modes rather than returning null, and a
  // ticket purchase should not fail because of that.
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;

    const created = newId();
    localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return newId();
  }
}
