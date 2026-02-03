/**
 * Password hashing utility using HMAC-SHA256
 */

import crypto from 'crypto';

/**
 * Hash a password using HMAC-SHA256 with a secret key
 * @param password - Plaintext password to hash
 * @param secret - Server secret key for HMAC
 * @returns Hexadecimal hash string (64 characters)
 */
export function hashPassword(password: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(password).digest('hex');
}

/**
 * Verify a password against a stored hash
 * @param password - Plaintext password to verify
 * @param hash - Stored password hash
 * @param secret - Server secret key used for hashing
 * @returns True if password matches hash, false otherwise
 */
export function verifyPassword(password: string, hash: string, secret: string): boolean {
  const computedHash = hashPassword(password, secret);
  return computedHash === hash;
}
