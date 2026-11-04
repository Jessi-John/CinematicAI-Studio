import { defineConfig, globalIgnores } from "eslint/config";
import nextConfig from "eslint-config-next";
import testQualityPlugin from "./eslint-plugins/test-quality.mjs";

const eslintConfig = defineConfig([
  ...nextConfig,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "next.config.ts",
    "backend/**",
    "dist/**",
    "node_modules/**",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "cinematicai-test-quality": testQualityPlugin,
    },
    // E2E files get only the test-quality guardrails (defined below).
    // The other rules (no-console, no-raw-fetch) were intentionally
    // excluded from E2E — Playwright specs use raw HTTP calls against the
    // running backend and may log diagnostics, so the project apiFetch
    // wrapper and no-console rule do not apply here.
    ignores: ["lib/utils/api.ts", "app/api/**/route.ts", "e2e/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_+", varsIgnorePattern: "^_+" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "cinematicai-test-quality/no-local-imported-function-collision": "warn",
      // MEDIUM #46: Frontend/BFF source files must not read process.env at
      // module level before env validation runs. Test files are skipped by
      // the rule itself; allowlisted config files are also skipped.
      "cinematicai-test-quality/no-module-level-process-env": "error",

      // Temporary console.warn / console.error in these specific files:
      // app/not-found.tsx — logs 404 navigation for debugging
      // hooks/use-generation.ts — logs SSE errors for debugging
      // These should be migrated to a structured logger when available.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            "Do not use raw fetch. Use 'apiFetch' (JSON responses) or 'apiRawFetch' (binary responses) from '@/lib/utils/api'. Both handle auth and CSRF automatically.",
        },
        {
          selector:
            "MemberExpression[object.name='window'][property.name='fetch']",
          message:
            "Do not use window.fetch. Use 'apiFetch' or 'apiRawFetch' from '@/lib/utils/api'.",
        },
      ],
    },
  },
  // apiFetch/apiRawFetch implementation uses raw fetch internally — no restrictions here.
  // `server-api.ts` is a server-only helper that forwards the user's auth
  // cookies to the backend. It cannot use the client `apiFetch` wrapper.
  {
    files: [
      "lib/utils/api.ts",
      "lib/utils/server-api.ts",
      "app/api/**/route.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_+", varsIgnorePattern: "^_+" },
      ],
    },
  },
  // Test-quality guardrails (see eslint-plugins/test-quality.mjs).
  // Applied to *.test.* and *.spec.* files; non-test files are unaffected.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    plugins: {
      "cinematicai-test-quality": testQualityPlugin,
    },
    rules: {
      "cinematicai-test-quality/no-trivial-assertions": "error",
      "cinematicai-test-quality/click-needs-assertion": "error",
      "cinematicai-test-quality/test-against-project-middleware": "error",
      "cinematicai-test-quality/no-module-level-process-env": "error",
    },
  },
  // E2E test files get only the test-quality guardrails. The other
  // frontend rules (no-console, no-restricted-syntax for fetch, etc.)
  // are intentionally excluded from E2E because Playwright specs use
  // console.log sparingly for diagnostic output and raw page.evaluate
  // calls. We do want the trivial-assertion rule to apply because
  // Playwright locators can suffer from the same `toBeDefined()`
  // trivial-assertion pattern.
  {
    files: ["e2e/**/*.ts"],
    plugins: {
      "cinematicai-test-quality": testQualityPlugin,
    },
    rules: {
      "cinematicai-test-quality/no-trivial-assertions": "error",
      "cinematicai-test-quality/click-needs-assertion": "error",
      "cinematicai-test-quality/test-against-project-middleware": "error",
      "cinematicai-test-quality/no-module-level-process-env": "error",
    },
  },
  // All JSX/TSX files: ban redundant onKeyDown on <button> elements.
  {
    files: ["**/*.tsx", "**/*.jsx"],
    plugins: {
      "cinematicai-test-quality": testQualityPlugin,
    },
    rules: {
      "cinematicai-test-quality/no-redundant-button-onkeydown": "error",
    },
  },
  // All source files: prefer GENRE_MAP over GENRES.find().
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "cinematicai-test-quality": testQualityPlugin,
    },
    rules: {
      "cinematicai-test-quality/prefer-genre-map": "warn",
    },
  },
]);

export default eslintConfig;

