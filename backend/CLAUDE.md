# Backend — Code Conventions

## Lint & Type Check

All commands must pass with zero errors before merging:

```bash
npm run lint    # 0 errors (warnings are acceptable)
npm run typecheck
npm run build
npm test
```

CI enforces these as a mandatory gate.

## ESLint Conventions

### Unused Variables

Prefix intentionally unused variables with an underscore (`_` or `__`). The ESLint `varsIgnorePattern: '^_+'` ignores any identifier starting with one or more underscores.

```typescript
const _gradeFloor = 'B';    // ignored by varsIgnorePattern: '^_+'
const __scenes = 5;         // also ignored
function _getScenesPerEpisode(): number { ... }
```

### eslint-disable

Use `// eslint-disable-next-line` only when a rule must be suppressed for a specific line. Always verify the rule actually fires before adding the directive — stale disable comments become warnings.

### @typescript-eslint/no-explicit-any

Set to `warn` (not error). When using external libraries or dynamic patterns where a type cannot be reasonably inferred, `any` is acceptable.

## Pre-commit Hooks

Husky runs `lint-staged` on staged `.ts` files via `npx lint-staged`. The hook is at `.husky/pre-commit`.

## Key Patterns

### asyncHandler

The `asyncHandler` wrapper in `src/middleware/error.ts` accepts Express route handlers. It uses proper `Request`/`Response` typing — do not use `any` internally as it breaks TypeScript inference in route callbacks.

### Prisma Client

Always use `prisma()` (function) not `prisma` (const) to avoid eager instantiation in tests. See `src/database/prisma.ts`.

### Generation Logger

In `src/services/generation-logger.ts`, use simple `for` loops with `catch {}` (no caught variable) for retry logic. This avoids the `varsIgnorePattern: '^_+'` matching issue with `__err`.