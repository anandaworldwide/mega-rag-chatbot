/**
 * Redis Cache Utilities - Ananda Library Chatbot
 *
 * This module provides a comprehensive Redis-based caching layer for the Next.js application,
 * designed to improve performance by caching frequently accessed data and reducing database load.
 *
 * Key Features:
 * - Type-safe Redis client wrapper with comprehensive error handling
 * - Automatic connection management with graceful fallback when Redis is unavailable
 * - Configurable cache expiration (1 hour dev, 24 hours prod)
 * - Input validation and sanitization to prevent cache poisoning attacks
 * - Size limits (1MB max) to prevent memory exhaustion
 * - Global cache service singleton for application-wide use
 * - Testing utilities for unit test isolation
 *
 * Architecture:
 * - Uses Upstash Redis for serverless-friendly Redis hosting
 * - Implements CacheService interface for dependency injection and testing
 * - Provides both class-based (RedisCacheService) and functional APIs
 * - Environment-aware configuration with development/production modes
 *
 * Security Considerations:
 * - Validates cache keys to prevent injection attacks
 * - Sanitizes values before storage to prevent malicious data
 * - Enforces size limits to prevent DoS attacks
 * - Graceful degradation when Redis is unavailable (no app crashes)
 *
 * Usage:
 * - Import getFromCache/setInCache for simple caching operations
 * - Use RedisCacheService class for advanced scenarios with custom configuration
 * - Leverage __setGlobalRedisClientForTesting for unit tests
 *
 * Dependencies:
 * - @upstash/redis: Serverless Redis client
 * - Environment variables: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis";
import { isDevelopment } from "@/utils/env";

// Types for better type safety
export interface RedisConfig {
  url?: string;
  token?: string;
}

export interface RedisClientInterface {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: { ex?: number; nx?: boolean }): Promise<string | null>;
  del(key: string): Promise<number>;
  ping(): Promise<string>;
}

export interface CacheService {
  getFromCache<T>(key: string): Promise<T | null>;
  setInCache(key: string, value: string | number | boolean | null | object, expiration?: number): Promise<void>;
  setInCacheIfNotExists(
    key: string,
    value: string | number | boolean | null | object,
    expiration?: number
  ): Promise<boolean>;
  deleteFromCache(key: string): Promise<void>;
  isAvailable(): boolean;
  clearCache?(): Promise<void>;
}

// Environment configuration interface
export interface EnvironmentConfig {
  isDevelopment: () => boolean;
  getRedisUrl: () => string | undefined;
  getRedisToken: () => string | undefined;
}

// Default environment configuration
const defaultEnvironmentConfig: EnvironmentConfig = {
  isDevelopment,
  getRedisUrl: () => process.env.UPSTASH_REDIS_REST_URL,
  getRedisToken: () => process.env.UPSTASH_REDIS_REST_TOKEN,
};

// Cache expiration constants
export const getCacheExpiration = (envConfig: EnvironmentConfig = defaultEnvironmentConfig): number =>
  envConfig.isDevelopment() ? 3600 : 86400; // 1 hour for dev, 24 hours for prod

// Legacy constant for backward compatibility
export const CACHE_EXPIRATION = getCacheExpiration();

// Redis client factory
export function createRedisClient(config: RedisConfig): RedisClientInterface {
  return new Redis({
    url: config.url,
    token: config.token,
  });
}

// Validate cache key for security
export function validateCacheKey(key: string): void {
  if (typeof key !== "string") {
    throw new Error("Cache key must be a string");
  }

  if (key.length === 0) {
    throw new Error("Cache key cannot be empty");
  }

  if (key.length > 250) {
    throw new Error("Cache key too long (max 250 characters)");
  }

  // Prevent potential injection attacks
  if (key.includes("\n") || key.includes("\r") || key.includes("\0")) {
    throw new Error("Cache key contains invalid characters");
  }

  // Prevent keys that could cause issues with Redis
  if (key.startsWith(" ") || key.endsWith(" ")) {
    throw new Error("Cache key cannot start or end with whitespace");
  }
}

// Sanitize cache value for security
export function sanitizeCacheValue(value: string | number | boolean | null | object): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    // Prevent potential security issues with very large strings
    if (value.length > 1048576) {
      // 1MB limit
      throw new Error("Cache value too large (max 1MB)");
    }
    return JSON.stringify(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 1048576) {
      // 1MB limit
      throw new Error("Cache value too large (max 1MB)");
    }
    return serialized;
  } catch (error) {
    // Check if it's a specific size error first
    if (error instanceof Error && error.message === "Cache value too large (max 1MB)") {
      throw error;
    }
    throw new Error("Cache value cannot be serialized to JSON");
  }
}

// Parse cache value safely
export function parseCacheValue<T>(cachedData: string | null): T | null {
  if (cachedData === null) return null;

  try {
    return JSON.parse(cachedData) as T;
  } catch (e) {
    if (e instanceof SyntaxError) {
      // If parsing fails due to SyntaxError, assume it's already the correct type
      return cachedData as unknown as T;
    }
    throw e; // Re-throw if it's not a SyntaxError
  }
}

// Redis cache service implementation
export class RedisCacheService implements CacheService {
  private redisClient: RedisClientInterface | null = null;
  private readonly envConfig: EnvironmentConfig;
  private readonly defaultExpiration: number;

  constructor(envConfig: EnvironmentConfig = defaultEnvironmentConfig) {
    this.envConfig = envConfig;
    this.defaultExpiration = getCacheExpiration(envConfig);
  }

  private async initializeRedis(): Promise<RedisClientInterface | null> {
    if (this.redisClient === null) {
      try {
        const url = this.envConfig.getRedisUrl();
        const token = this.envConfig.getRedisToken();

        if (!url || !token) {
          console.warn("Redis configuration missing - caching disabled");
          return null;
        }

        this.redisClient = createRedisClient({ url, token });

        // Test the connection
        await this.redisClient.ping();
      } catch (error) {
        console.error("Redis Cache not available:", error);
        this.redisClient = null; // Ensure redis is set to null if connection fails
      }
    }
    return this.redisClient;
  }

  async getFromCache<T>(key: string): Promise<T | null> {
    try {
      validateCacheKey(key);

      const redisClient = await this.initializeRedis();
      if (!redisClient) return null;

      const cachedData = await redisClient.get<string | null>(key);
      return parseCacheValue<T>(cachedData);
    } catch (error) {
      console.error(`Error fetching from cache for key '${key}':`, error);
      return null;
    }
  }

  async setInCache(
    key: string,
    value: string | number | boolean | null | object,
    expiration: number = this.defaultExpiration
  ): Promise<void> {
    try {
      validateCacheKey(key);

      if (expiration < 0) {
        throw new Error("Cache expiration must be non-negative");
      }

      if (expiration > 2147483647) {
        // Redis max TTL
        throw new Error("Cache expiration too large (max ~68 years)");
      }

      const redisClient = await this.initializeRedis();
      if (!redisClient) return;

      const serializedValue = sanitizeCacheValue(value);
      await redisClient.set(key, serializedValue, { ex: expiration });
    } catch (error) {
      console.error(`Error setting in cache for key '${key}':`, error);
    }
  }

  async setInCacheIfNotExists(
    key: string,
    value: string | number | boolean | null | object,
    expiration: number = this.defaultExpiration
  ): Promise<boolean> {
    try {
      validateCacheKey(key);

      if (expiration < 0) {
        throw new Error("Cache expiration must be non-negative");
      }

      const redisClient = await this.initializeRedis();
      if (!redisClient) {
        return true;
      }

      const serializedValue = sanitizeCacheValue(value);
      const result = await redisClient.set(key, serializedValue, { ex: expiration, nx: true });
      return result === "OK";
    } catch (error) {
      console.error(`Error setting cache key '${key}' with NX:`, error);
      return true;
    }
  }

  async deleteFromCache(key: string): Promise<void> {
    try {
      validateCacheKey(key);

      const redisClient = await this.initializeRedis();
      if (!redisClient) return;

      await redisClient.del(key);
    } catch (error) {
      console.error(`Error deleting from cache for key '${key}':`, error);
    }
  }

  isAvailable(): boolean {
    return this.redisClient !== null;
  }

  async clearCache(): Promise<void> {
    // Note: This is a dangerous operation and should be used carefully
    // For testing purposes only
    this.redisClient = null;
  }

  // Method to inject a mock client for testing
  setRedisClient(client: RedisClientInterface | null): void {
    this.redisClient = client;
  }
}

// Global singleton instance for backward compatibility
let globalCacheService: RedisCacheService | null = null;

function getGlobalCacheService(): RedisCacheService {
  if (globalCacheService === null) {
    globalCacheService = new RedisCacheService();
  }
  return globalCacheService;
}

// Legacy functions for backward compatibility

export async function getFromCache<T>(key: string): Promise<T | null> {
  const service = getGlobalCacheService();
  return service.getFromCache<T>(key);
}

export async function setInCache(
  key: string,
  value: string | number | boolean | null | object,
  expiration: number = CACHE_EXPIRATION
): Promise<void> {
  const service = getGlobalCacheService();
  return service.setInCache(key, value, expiration);
}

export async function setInCacheIfNotExists(
  key: string,
  value: string | number | boolean | null | object,
  expiration: number = CACHE_EXPIRATION
): Promise<boolean> {
  const service = getGlobalCacheService();
  return service.setInCacheIfNotExists(key, value, expiration);
}

export async function deleteFromCache(key: string): Promise<void> {
  const service = getGlobalCacheService();
  return service.deleteFromCache(key);
}

// Export the service class and factory function for dependency injection
export { RedisCacheService as CacheServiceImpl };
export function createCacheService(envConfig?: EnvironmentConfig): CacheService {
  return new RedisCacheService(envConfig);
}

// Test utility function to inject mock client into global service
export function __setGlobalRedisClientForTesting(client: RedisClientInterface | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("This function should only be used in test environment");
  }
  const service = getGlobalCacheService();
  service.setRedisClient(client);
}
