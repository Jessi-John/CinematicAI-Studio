<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Unused variables

Prefix intentionally unused variables with an underscore (`_` or `__`). The ESLint `varsIgnorePattern: '^_+'` ignores any identifier starting with one or more underscores.

## Before concluding

Run `npm run lint && npm run typecheck && npm test` on both the frontend (root) and backend (`backend/`).
