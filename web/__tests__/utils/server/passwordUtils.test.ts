/**
 * Password Utils Tests
 *
 * These tests verify the password utility functions for token validation
 * and timestamp management. The utilities should:
 *
 * 1. Correctly read and parse password change timestamps from environment
 * 2. Validate tokens against password change timestamps
 * 3. Handle both millisecond and second timestamp formats
 * 4. Handle edge cases and invalid inputs gracefully
 */

import {
  getLastPasswordChangeTimestamp,
  isTokenValid,
  validatePasswordStrength,
  hashPassword,
  comparePassword,
} from '@/utils/server/passwordUtils';

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn(),
}));

import bcrypt from 'bcryptjs';

describe('passwordUtils', () => {
  // Store original env var to restore after tests
  const originalEnv = process.env.LAST_PASSWORD_CHANGE_TIMESTAMP;

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv !== undefined) {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = originalEnv;
    } else {
      delete process.env.LAST_PASSWORD_CHANGE_TIMESTAMP;
    }
  });

  describe('getLastPasswordChangeTimestamp', () => {
    it('should return parsed timestamp when env var is set with valid number', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200';
      expect(getLastPasswordChangeTimestamp()).toBe(1672531200);
    });

    it('should return 0 when env var is not set', () => {
      delete process.env.LAST_PASSWORD_CHANGE_TIMESTAMP;
      expect(getLastPasswordChangeTimestamp()).toBe(0);
    });

    it('should return 0 when env var is empty string', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '';
      expect(getLastPasswordChangeTimestamp()).toBe(0);
    });

    it('should return NaN when env var is invalid number', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = 'invalid';
      expect(getLastPasswordChangeTimestamp()).toBe(NaN);
    });

    it('should handle zero timestamp', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '0';
      expect(getLastPasswordChangeTimestamp()).toBe(0);
    });

    it('should handle negative timestamp', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '-123456789';
      expect(getLastPasswordChangeTimestamp()).toBe(-123456789);
    });

    it('should handle large timestamp values', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '999999999999';
      expect(getLastPasswordChangeTimestamp()).toBe(999999999999);
    });
  });

  describe('isTokenValid', () => {
    beforeEach(() => {
      // Set a baseline password change timestamp (January 1, 2023)
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200'; // Unix timestamp in seconds
    });

    it('should return true for valid token with timestamp in seconds format', () => {
      // Token timestamp after password change (January 2, 2023)
      const validToken = 'sometoken:1672617600';
      expect(isTokenValid(validToken)).toBe(true);
    });

    it('should return true for valid token with timestamp in milliseconds format', () => {
      // Token timestamp after password change (January 2, 2023 in milliseconds)
      const validToken = 'sometoken:1672617600000';
      expect(isTokenValid(validToken)).toBe(true);
    });

    it('should return false for token with timestamp before password change (seconds)', () => {
      // Token timestamp before password change (December 31, 2022)
      const invalidToken = 'sometoken:1672444800';
      expect(isTokenValid(invalidToken)).toBe(false);
    });

    it('should return false for token with timestamp before password change (milliseconds)', () => {
      // Token timestamp before password change (December 31, 2022 in milliseconds)
      const invalidToken = 'sometoken:1672444800000';
      expect(isTokenValid(invalidToken)).toBe(false);
    });

    it('should handle token exactly at password change timestamp (seconds)', () => {
      // Token timestamp exactly at password change time
      const tokenAtChange = 'sometoken:1672531200';
      expect(isTokenValid(tokenAtChange)).toBe(false); // Should be > not >=
    });

    it('should handle token exactly at password change timestamp (milliseconds)', () => {
      // Token timestamp exactly at password change time in milliseconds
      const tokenAtChange = 'sometoken:1672531200000';
      expect(isTokenValid(tokenAtChange)).toBe(false); // Should be > not >=
    });

    it('should handle malformed token without colon', () => {
      const malformedToken = 'sometokenwithoutcolon';
      // This will try to parse undefined, which becomes NaN
      expect(isTokenValid(malformedToken)).toBe(false);
    });

    it('should handle token with empty timestamp', () => {
      const tokenWithEmptyTimestamp = 'sometoken:';
      expect(isTokenValid(tokenWithEmptyTimestamp)).toBe(false);
    });

    it('should handle token with non-numeric timestamp', () => {
      const tokenWithInvalidTimestamp = 'sometoken:notanumber';
      expect(isTokenValid(tokenWithInvalidTimestamp)).toBe(false);
    });

    it('should handle token with multiple colons', () => {
      // Destructuring takes second element, so 'some:token:1672617600' -> 'token' -> NaN -> false
      const tokenWithMultipleColons = 'some:token:1672617600';
      expect(isTokenValid(tokenWithMultipleColons)).toBe(false);
    });

    it('should correctly convert millisecond timestamp at boundary (9999999999)', () => {
      // Timestamp of 9999999999 should be treated as seconds (just under the 10-digit threshold)
      const boundaryToken = 'sometoken:9999999999';
      expect(isTokenValid(boundaryToken)).toBe(true);
    });

    it('should correctly convert millisecond timestamp at boundary (10000000000)', () => {
      // Timestamp of 10000000000 converts to 10000000 seconds (1970), which is before 2023 password change
      const boundaryToken = 'sometoken:10000000000';
      expect(isTokenValid(boundaryToken)).toBe(false);
    });

    it('should correctly convert valid millisecond timestamp above boundary', () => {
      // Future millisecond timestamp (2024) that should convert and be valid
      const futureMillisecondToken = 'sometoken:1704067200000'; // Jan 1, 2024 in milliseconds
      expect(isTokenValid(futureMillisecondToken)).toBe(true);
    });

    it('should handle zero timestamp', () => {
      const zeroTimestampToken = 'sometoken:0';
      expect(isTokenValid(zeroTimestampToken)).toBe(false);
    });

    it('should handle negative timestamp', () => {
      const negativeTimestampToken = 'sometoken:-123456789';
      expect(isTokenValid(negativeTimestampToken)).toBe(false);
    });

    it('should handle very large millisecond timestamp', () => {
      // Very large millisecond timestamp (year 2050+)
      const futureToken = 'sometoken:2556144000000';
      expect(isTokenValid(futureToken)).toBe(true);
    });

    it('should work when password change timestamp is 0', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '0';
      const validToken = 'sometoken:1672617600';
      expect(isTokenValid(validToken)).toBe(true);
    });

    it('should work when password change timestamp is NaN', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = 'invalid';
      const validToken = 'sometoken:1672617600';
      // NaN comparison always returns false, so this should return false
      expect(isTokenValid(validToken)).toBe(false);
    });

    it('should handle edge case where token timestamp conversion results in same value', () => {
      // Test case where millisecond timestamp divided by 1000 equals the original seconds timestamp
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200';
      // 1672531201000 / 1000 = 1672531201 (one second after password change)
      const edgeCaseToken = 'sometoken:1672531201000';
      expect(isTokenValid(edgeCaseToken)).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should validate realistic authentication flow', () => {
      // Simulate password change on January 1, 2023
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200';
      
      // User logs in on January 2, 2023 - should be valid
      const recentLoginToken = 'usertoken:1672617600';
      expect(isTokenValid(recentLoginToken)).toBe(true);
      
      // Old session from December 2022 - should be invalid
      const oldSessionToken = 'oldsession:1672444800';
      expect(isTokenValid(oldSessionToken)).toBe(false);
    });

    it('should handle password rotation scenario', () => {
      // Initial password change timestamp
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200';
      
      // Token created after first password change
      const firstToken = 'token1:1672617600';
      expect(isTokenValid(firstToken)).toBe(true);
      
      // Password gets changed again (security incident)
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672704000'; // January 3, 2023
      
      // First token should now be invalid
      expect(isTokenValid(firstToken)).toBe(false);
      
      // New token after second password change should be valid
      const secondToken = 'token2:1672790400'; // January 4, 2023
      expect(isTokenValid(secondToken)).toBe(true);
    });

    it('should handle mixed timestamp formats in same session', () => {
      process.env.LAST_PASSWORD_CHANGE_TIMESTAMP = '1672531200';
      
      // Both seconds and milliseconds format should work consistently
      const secondsToken = 'token1:1672617600';
      const millisecondsToken = 'token2:1672617600000';
      
      expect(isTokenValid(secondsToken)).toBe(true);
      expect(isTokenValid(millisecondsToken)).toBe(true);
    });
  });

  describe('validatePasswordStrength', () => {
    it('rejects empty password', () => {
      expect(validatePasswordStrength('')).toEqual({
        valid: false,
        message: 'Password is required',
      });
    });

    it('rejects non-string password', () => {
      expect(validatePasswordStrength(null as unknown as string)).toEqual({
        valid: false,
        message: 'Password is required',
      });
    });

    it('rejects password missing requirements', () => {
      const result = validatePasswordStrength('short');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('at least 8 characters');
      expect(result.message).toContain('one uppercase letter');
      expect(result.message).toContain('one number');
    });

    it('accepts password meeting all requirements', () => {
      const result = validatePasswordStrength('SecurePass1');
      expect(result).toEqual({
        valid: true,
        message: 'Password meets all requirements',
        requirements: {
          minLength: true,
          hasUppercase: true,
          hasLowercase: true,
          hasNumber: true,
        },
      });
    });
  });

  describe('hashPassword', () => {
    it('hashes password with bcrypt salt rounds 10', async () => {
      const result = await hashPassword('SecurePass1');
      expect(bcrypt.hash).toHaveBeenCalledWith('SecurePass1', 10);
      expect(result).toBe('hashed-password');
    });
  });

  describe('comparePassword', () => {
    it('returns true when bcrypt compare succeeds', async () => {
      jest.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);
      await expect(comparePassword('plain', 'hash')).resolves.toBe(true);
    });

    it('returns false when bcrypt compare fails', async () => {
      jest.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);
      await expect(comparePassword('plain', 'hash')).resolves.toBe(false);
    });

    it('returns false when bcrypt throws', async () => {
      jest.mocked(bcrypt.compare).mockRejectedValueOnce(new Error('bcrypt error'));
      await expect(comparePassword('plain', 'hash')).resolves.toBe(false);
    });
  });
});