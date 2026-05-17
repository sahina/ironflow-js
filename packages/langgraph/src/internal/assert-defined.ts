/**
 * Test-side assertion that narrows `T | null | undefined` to `T`.
 *
 * Used at sites where `noUncheckedIndexedAccess` widens an array index
 * lookup to `T | undefined`, or where an API surface returns `T | null`.
 * Throws with a useful message instead of scattering bare `!` non-null
 * assertions across test code.
 */
export function assertDefined<T>(
  value: T | null | undefined,
  label = "value"
): T {
  if (value === undefined || value === null) {
    throw new Error(`assertDefined: expected ${label} to be defined`);
  }
  return value;
}
