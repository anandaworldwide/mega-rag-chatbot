/**
 * Tests for the uuid utility
 */

import { getOrCreateUUID, resetProfileUuidCacheForTests, syncProfileUuid } from '@/utils/client/uuid';
import Cookies from 'js-cookie';
import { v4 as uuidv4 } from 'uuid';

// Mock the dependencies
jest.mock('js-cookie');
jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

describe('uuid', () => {
  // Mock implementations
  const mockGet = jest.fn();
  const mockSet = jest.fn();
  const mockUuidValue = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    resetProfileUuidCacheForTests();

    // Setup Cookies mock implementation
    (Cookies.get as jest.Mock).mockImplementation(mockGet);
    (Cookies.set as jest.Mock).mockImplementation(mockSet);

    // Setup UUID mock to return a consistent value
    (uuidv4 as jest.Mock).mockReturnValue(mockUuidValue);
  });

  it('should return existing UUID from cookies if present', () => {
    const existingUuid = 'existing-uuid-value';
    mockGet.mockReturnValue(existingUuid);

    const result = getOrCreateUUID();

    expect(result).toBe(existingUuid);
    expect(Cookies.get).toHaveBeenCalledWith('uuid');
    expect(uuidv4).not.toHaveBeenCalled();
    expect(Cookies.set).not.toHaveBeenCalled();
  });

  it('should create a new UUID if none exists in cookies', () => {
    // Simulate no existing cookie
    mockGet.mockReturnValue(undefined);

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(Cookies.get).toHaveBeenCalledWith('uuid');
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).toHaveBeenCalledWith('uuid', mockUuidValue, {
      expires: 365,
    });
  });

  it('should create a new UUID if cookie value is empty string', () => {
    mockGet.mockReturnValue('');

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).toHaveBeenCalledWith('uuid', mockUuidValue, {
      expires: 365,
    });
  });

  it('should create a new UUID if cookie value is null', () => {
    mockGet.mockReturnValue(null);

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).toHaveBeenCalledWith('uuid', mockUuidValue, {
      expires: 365,
    });
  });

  it('should set the cookie with 1 year expiration', () => {
    mockGet.mockReturnValue(undefined);

    getOrCreateUUID();

    expect(Cookies.set).toHaveBeenCalledWith('uuid', mockUuidValue, {
      expires: 365,
    });
  });

  it('returns profile uuid from cache after syncProfileUuid', () => {
    const profileId = 'profile-uuid-from-auth';
    mockGet.mockReturnValue('stale-cookie-uuid');

    syncProfileUuid(profileId);
    const result = getOrCreateUUID();

    expect(result).toBe(profileId);
    expect(uuidv4).not.toHaveBeenCalled();
  });

  it('does not write a cookie when syncing the profile uuid', () => {
    mockGet.mockReturnValue('old-cookie-uuid');

    syncProfileUuid('profile-uuid-from-auth');

    // In-memory only: the signed uuid cookie is owned by the server, not the client.
    expect(Cookies.set).not.toHaveBeenCalled();
    expect(getOrCreateUUID()).toBe('profile-uuid-from-auth');
  });
});
