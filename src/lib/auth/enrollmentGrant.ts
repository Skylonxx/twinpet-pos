/**
 * TPOS-R7 first-enrollment preparation grant.
 *
 * `beginDeviceRegistration` binds its session to the current Firebase UID, so
 * a fresh enrollment may begin only after the AuthProvider's
 * `prepareEnrollmentIdentity()` has ended any staff session and established a
 * dedicated anonymous identity. A UID string is not proof of that: any caller
 * can read `auth.currentUser.uid`. The proof is this grant.
 *
 * Runtime (not type-only) authenticity:
 *  - a grant is an empty frozen object; it carries no data a caller could copy;
 *  - the only valid grant is the one held in this module's private `active`
 *    slot, compared by object identity, so a constructed object or string is
 *    never accepted;
 *  - the minter is handed out exactly once and is claimed by the AuthProvider
 *    module at load, so no other module can issue grants (a second claim in a
 *    production build throws, making a stolen minter visible as a load failure);
 *  - a grant is one-shot: taking it clears the slot whether or not the
 *    registration then passes its boundary checks, and a newer mint replaces
 *    (revokes) any older grant.
 */

/** Opaque one-shot capability returned by `prepareEnrollmentIdentity()`. */
export type EnrollmentPreparationGrant = { readonly __enrollmentPreparationGrant: unique symbol };

/** What the preparation bound the grant to; rechecked at the registration boundary. */
export interface EnrollmentGrantBinding {
  /** The exact anonymous Firebase UID the preparation established. */
  readonly requesterUid: string;
  /** False once a newer auth operation (login, PIN, logout, re-preparation) started. */
  readonly isPreparationCurrent: () => boolean;
  /** Fresh native readiness; a fresh enrollment requires exactly NOT_ENROLLED. */
  readonly readDeviceReadiness: () => Promise<string>;
}

let active: { grant: object; binding: EnrollmentGrantBinding } | null = null;
let minterClaimed = false;

/**
 * Hands out the only grant minter. The AuthProvider module claims it at load;
 * any later claim throws. (Vite dev HMR re-evaluates the AuthProvider module,
 * so a re-claim is tolerated only while `import.meta.hot` exists — statically
 * absent from production builds and tests.)
 */
export function claimEnrollmentGrantMinter(): (binding: EnrollmentGrantBinding) => EnrollmentPreparationGrant {
  if (minterClaimed && !import.meta.hot) {
    throw new Error('Enrollment grant minter already claimed');
  }
  minterClaimed = true;
  return (binding) => {
    const grant = Object.freeze(Object.create(null) as object);
    active = { grant, binding: Object.freeze({ ...binding }) };
    return grant as EnrollmentPreparationGrant;
  };
}

/** Drops any outstanding grant (it can only reduce authority). */
export function revokeEnrollmentGrant(): void {
  active = null;
}

/**
 * Consumes `grant` if it is exactly the live grant and returns its binding;
 * otherwise returns null. Synchronous, so a second concurrent use of the same
 * grant always sees it already taken.
 */
export function takeEnrollmentGrant(grant: unknown): EnrollmentGrantBinding | null {
  const live = active;
  if (!live || grant == null || live.grant !== grant) return null;
  active = null;
  return live.binding;
}
