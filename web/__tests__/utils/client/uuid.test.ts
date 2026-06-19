/**
 * Tests for the uuid utility
 */

import {
  getOrCreateUUID,
  resetProfileUuidCacheForTests,
  syncProfileUuid,
  syncUuidFromSignedCookie,
} from '@/utils/client/uuid';
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
  const mockUuidValue = '123e4567-e89b-12d3-a456-426614174000';
  const serverSignedUuid = '423e4567-e89b-42d3-a456-426614174000';

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    resetProfileUuidCacheForTests();

    // Setup Cookies mock implementation
    (Cookies.get as jest.Mock).mockImplementation(mockGet);

    // Setup UUID mock to return a consistent value
    (uuidv4 as jest.Mock).mockReturnValue(mockUuidValue);
  });

  it('should return existing UUID from signed cookies if present', () => {
    const existingUuid = '123e4567-e89b-12d3-a456-426614174000';
    const signedCookie = `${existingUuid}--deadbeef`;
    mockGet.mockReturnValue(signedCookie);

    const result = getOrCreateUUID();

    expect(result).toBe(existingUuid);
    expect(Cookies.get).toHaveBeenCalledWith('uuid');
    expect(uuidv4).not.toHaveBeenCalled();
  });

  it('should create a new in-memory UUID if no signed cookie exists', () => {
    mockGet.mockReturnValue(undefined);

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(Cookies.get).toHaveBeenCalledWith('uuid');
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).not.toHaveBeenCalled();
  });

  it('should create a new in-memory UUID if cookie value is empty string', () => {
    mockGet.mockReturnValue('');

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).not.toHaveBeenCalled();
  });

  it('should create a new in-memory UUID if cookie value is null', () => {
    mockGet.mockReturnValue(null);

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).not.toHaveBeenCalled();
  });

  it('should ignore unsigned legacy cookies and create a new in-memory UUID', () => {
    mockGet.mockReturnValue('unsigned-legacy-uuid');

    const result = getOrCreateUUID();

    expect(result).toBe(mockUuidValue);
    expect(uuidv4).toHaveBeenCalledTimes(1);
    expect(Cookies.set).not.toHaveBeenCalled();
  });

  it('prefers signed cookie over provisional in-memory uuid after server bootstrap', () => {
    mockGet.mockReturnValue(undefined);
    expect(getOrCreateUUID()).toBe(mockUuidValue);

    mockGet.mockReturnValue(`${serverSignedUuid}--deadbeef`);
    expect(getOrCreateUUID()).toBe(serverSignedUuid);
    expect(uuidv4).toHaveBeenCalledTimes(1);
  });

  it('syncUuidFromSignedCookie aligns client with server-signed cookie', () => {
    mockGet.mockReturnValue(undefined);
    getOrCreateUUID();

    mockGet.mockReturnValue(`${serverSignedUuid}--deadbeef`);
    expect(syncUuidFromSignedCookie()).toBe(serverSignedUuid);
    expect(getOrCreateUUID()).toBe(serverSignedUuid);
  });

  it('adopts re-signed legacy uuid once server sets signed cookie format', () => {
    const legacyUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockGet.mockReturnValue(legacyUuid);
    expect(getOrCreateUUID()).toBe(mockUuidValue);

    mockGet.mockReturnValue(`${legacyUuid}--cafebabe`);
    expect(syncUuidFromSignedCookie()).toBe(legacyUuid);
    expect(getOrCreateUUID()).toBe(legacyUuid);
  });

  it('returns profile uuid from cache after syncProfileUuid', () => {
    const profileId = 'profile-uuid-from-auth';
    mockGet.mockReturnValue('stale-cookie-uuid');

    syncProfileUuid(profileId);
    const result = getOrCreateUUID();

    expect(result).toBe(profileId);
    expect(uuidv4).not.toHaveBeenCalled();
  });

  it('prefers auth profile uuid over signed cookie', () => {
    syncProfileUuid('profile-uuid-from-auth');
    mockGet.mockReturnValue(`${serverSignedUuid}--deadbeef`);

    expect(getOrCreateUUID()).toBe('profile-uuid-from-auth');
  });

  it('does not write a cookie when syncing the profile uuid', () => {
    mockGet.mockReturnValue('old-cookie-uuid');

    syncProfileUuid('profile-uuid-from-auth');

    // In-memory only: the signed uuid cookie is owned by the server, not the client.
    expect(Cookies.set).not.toHaveBeenCalled();
    expect(getOrCreateUUID()).toBe('profile-uuid-from-auth');
  });
});
