# Pull Request

## Summary

<!-- What changed and why? Keep this focused on the problem being solved. -->

## Related issues

<!-- Use "Fixes #123" to close an issue on merge, or "Refs #123" for related work. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Test improvement
- [ ] Build, CI, or dependency change
- [ ] Breaking change (describe below)

## Changes made

<!-- List the concrete changes. Mention any API, database, or configuration changes. -->

## Testing performed

<!-- Check the commands you actually ran. Do not check commands you did not run. -->

- [ ] `npm run lint` (root)
- [ ] `npm run typecheck` (root)
- [ ] `npm run typecheck:all` (root)
- [ ] `npx vitest run` (root)
- [ ] `npm run build` (root)
- [ ] `cd backend && npm run lint`
- [ ] `cd backend && npm run typecheck`
- [ ] `cd backend && npm run typecheck:all`
- [ ] `cd backend && npm test`
- [ ] `cd backend && npm run build`
- [ ] `npm run test:e2e` (if the change affects a user-facing flow)
- [ ] Manual verification (describe below)

### Manual verification details

<!-- What did you run, and what did you observe? Include sanitized logs if useful. -->

## Screenshots or recordings

<!-- For UI changes only. Remove secrets and personal data. -->

## Checklist

- [ ] I added or updated tests for behavior changes.
- [ ] I updated documentation and environment templates where needed.
- [ ] I updated `CHANGELOG.md` for user-visible changes.
- [ ] I did not include secrets, credentials, or generated artifacts.
- [ ] I did not weaken TypeScript, ESLint, or security checks to make this pass.
- [ ] I preserved existing functionality and did not include unrelated changes.
- [ ] I have read `CONTRIBUTING.md`.
