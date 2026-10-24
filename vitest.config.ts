import { defineConfig, configDefaults } from "vitest/config";

// mcp/ and packages/ are separate npm packages with their own node:test suites.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "mcp/**", "packages/**"] } });
