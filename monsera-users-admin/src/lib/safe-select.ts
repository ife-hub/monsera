/**
 * Field selections that never expose secrets (password hashes, partner API
 * keys) in API responses. Use these instead of `include: { user: true }` or
 * `include: { aggregator: true }`.
 */
export const safeUserSelect = {
  id: true,
  email: true,
  name: true,
  userType: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const safeAggregatorSelect = {
  id: true,
  userId: true,
  lastInteraction: true,
  name: true,
  outstanding: true,
  status: true,
  mail: true,
  logoUrl: true,
  balance: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const safeDiscoSelect = {
  id: true,
  userId: true,
  lastInteraction: true,
  name: true,
  status: true,
  mail: true,
  logoUrl: true,
  balance: true,
  outstanding: true,
  createdAt: true,
  updatedAt: true,
} as const;
