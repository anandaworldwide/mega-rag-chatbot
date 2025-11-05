// Mock implementation of uuid for Jest tests
const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";

module.exports = {
  v4: jest.fn(() => MOCK_UUID_V4),
  v1: jest.fn(() => "00000000-0000-1000-8000-000000000000"),
  v3: jest.fn(() => "00000000-0000-3000-8000-000000000000"),
  v5: jest.fn(() => "00000000-0000-5000-8000-000000000000"),
  validate: jest.fn(() => true),
  version: jest.fn(() => 4),
  __esModule: true,
  MOCK_UUID_V4,
};
