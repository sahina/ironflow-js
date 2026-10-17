// One copy per package: scripts/mirror-js-sync.sh publishes each package on its own.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", "dist-bundle", "src/gen"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "warn",
    },
  },
  {
    // Test doubles: async generators that only throw or wait, mocks that capture `this`,
    // loosely typed fixtures and console spies.
    files: ["**/*.test.ts", "**/__tests__/**"],
    rules: {
      "require-yield": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
]);
