/**
 * Global test setup
 * Runs before all test suites.
 */

// Suppress noisy logs during tests
process.env["LOG_LEVEL"] = "silent";
process.env["NODE_ENV"] = "test";

// Provide dummy env vars so modules don't throw on import
process.env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"] ?? "test-key";
process.env["SOLANA_RPC_URL"] = process.env["SOLANA_RPC_URL"] ?? "http://localhost:8899";
process.env["REDIS_URL"] = process.env["REDIS_URL"] ?? "redis://localhost:6379";
