import { Pinecone } from "@pinecone-database/pinecone";

// Types for better type safety and testing
export interface PineconeConfig {
  apiKey?: string;
  environment?: string;
}

export interface PineconeClientInterface {
  Index(indexName: string): any;
}

export interface PineconeIndexInterface {
  query(options: any): Promise<any>;
  upsert(options: any): Promise<any>;
  fetch(options: any): Promise<any>;
  deleteOne(id: string): Promise<any>;
  namespace(namespace: string): any;
}

export interface EnvironmentConfig {
  getPineconeApiKey: () => string | undefined;
  getPineconeEnvironment?: () => string | undefined;
}

export interface PineconeService {
  getClient(): Promise<PineconeClientInterface>;
  getIndex(indexName: string): Promise<PineconeIndexInterface>;
  clearCache(): void;
  isAvailable(): boolean;
}

// Default environment configuration
const defaultEnvironmentConfig: EnvironmentConfig = {
  getPineconeApiKey: () => process.env.PINECONE_API_KEY,
  getPineconeEnvironment: () => process.env.PINECONE_ENVIRONMENT,
};

// Validation functions for security
export function validateIndexName(indexName: string): void {
  if (typeof indexName !== "string") {
    throw new Error("Index name must be a string");
  }

  if (indexName.length === 0) {
    throw new Error("Index name cannot be empty");
  }

  if (indexName.length > 100) {
    throw new Error("Index name too long (max 100 characters)");
  }

  // Pinecone index names must be lowercase alphanumeric with hyphens
  if (!/^[a-z0-9-]+$/.test(indexName)) {
    throw new Error("Index name must contain only lowercase letters, numbers, and hyphens");
  }

  // Cannot start or end with hyphen
  if (indexName.startsWith("-") || indexName.endsWith("-")) {
    throw new Error("Index name cannot start or end with hyphen");
  }
}

export function validateApiKey(apiKey: string): void {
  if (typeof apiKey !== "string") {
    throw new Error("API key must be a string");
  }

  if (apiKey.length === 0) {
    throw new Error("API key cannot be empty");
  }

  // Check for common test/placeholder values first (before length check)
  const invalidKeys = ["test", "fake", "dummy", "placeholder", "your-api-key"];
  if (invalidKeys.some((invalid) => apiKey.toLowerCase().includes(invalid))) {
    throw new Error("API key appears to be a placeholder value");
  }

  // Basic format validation (Pinecone API keys are typically UUIDs)
  if (apiKey.length < 10) {
    throw new Error("API key appears to be invalid (too short)");
  }
}

// Pinecone client factory
export function createPineconeClient(config: PineconeConfig): PineconeClientInterface {
  if (!config.apiKey) {
    throw new Error("Pinecone API key is required");
  }

  validateApiKey(config.apiKey);

  return new Pinecone({
    apiKey: config.apiKey,
  });
}

// Pinecone service implementation
export class PineconeClientService implements PineconeService {
  private client: PineconeClientInterface | null = null;
  private indexCache: Record<string, PineconeIndexInterface> = {};
  private readonly envConfig: EnvironmentConfig;

  constructor(envConfig: EnvironmentConfig = defaultEnvironmentConfig) {
    this.envConfig = envConfig;
  }

  private async initializeClient(): Promise<PineconeClientInterface> {
    if (this.client === null) {
      try {
        const apiKey = this.envConfig.getPineconeApiKey();

        if (!apiKey) {
          throw new Error("Pinecone API key missing from environment");
        }

        const config: PineconeConfig = { apiKey };
        if (this.envConfig.getPineconeEnvironment) {
          config.environment = this.envConfig.getPineconeEnvironment();
        }

        this.client = createPineconeClient(config);
      } catch (error) {
        console.error("Error initializing Pinecone client:", error);
        throw new Error("Failed to initialize Pinecone client");
      }
    }
    return this.client;
  }

  async getClient(): Promise<PineconeClientInterface> {
    const startTime = Date.now();
    try {
      const client = await this.initializeClient();
      const setupTime = Date.now() - startTime;
      if (setupTime > 200) {
        console.log(`Pinecone client initialization took ${setupTime}ms`);
      }
      return client;
    } catch (error) {
      console.error("Pinecone client error:", error);
      // Re-throw the original error to preserve specific error messages
      throw error;
    }
  }

  async getIndex(indexName: string): Promise<PineconeIndexInterface> {
    try {
      validateIndexName(indexName);

      // Return from cache if available
      if (this.indexCache[indexName]) {
        return this.indexCache[indexName];
      }

      // Otherwise, get the client and create the index
      const client = await this.getClient();
      const index = client.Index(indexName);

      // Cache for future use
      this.indexCache[indexName] = index;

      return index;
    } catch (error) {
      console.error(`Error getting Pinecone index '${indexName}':`, error);
      // Re-throw the original error to preserve specific error messages
      throw error;
    }
  }

  clearCache(): void {
    this.indexCache = {};
    this.client = null;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  // Method to inject a mock client for testing
  setClient(client: PineconeClientInterface | null): void {
    this.client = client;
  }
}

// Global singleton instance for backward compatibility
let globalPineconeService: PineconeClientService | null = null;

function getGlobalPineconeService(): PineconeClientService {
  if (globalPineconeService === null) {
    globalPineconeService = new PineconeClientService();
  }
  return globalPineconeService;
}

// Legacy functions for backward compatibility
export const getPineconeClient = async (): Promise<PineconeClientInterface> => {
  const service = getGlobalPineconeService();
  return service.getClient();
};

export const getCachedPineconeIndex = async (indexName: string): Promise<PineconeIndexInterface> => {
  const service = getGlobalPineconeService();
  return service.getIndex(indexName);
};

// Export the service class and factory function for dependency injection
export { PineconeClientService as PineconeServiceImpl };
export function createPineconeService(envConfig?: EnvironmentConfig): PineconeService {
  return new PineconeClientService(envConfig);
}

// Test utility function to inject mock client into global service
export function __setGlobalPineconeClientForTesting(client: PineconeClientInterface | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("This function should only be used in test environment");
  }
  const service = getGlobalPineconeService();
  service.setClient(client);
  service.clearCache(); // Clear cache when setting new client
}
