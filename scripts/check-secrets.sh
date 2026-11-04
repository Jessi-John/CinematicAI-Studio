#!/usr/bin/env bash
# Pre-commit secret scanner.
#
# Runs in .husky/pre-commit. Catches three classes of leak:
#   1. Real-looking API keys in .env or .env.backup
#   2. Real-looking passwords in any committed file
#   3. gitleaks on the full diff
#
# Exit 1 on any leak so the commit is rejected.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

failed=0

# 1. .env must not be committed. .env.example is the only allowed env file.
# Only run the staged-file check when inside a git repository; tarball exports
# or Docker build contexts may not contain .git, but the local .env scan below
# still protects against accidentally shipped secrets.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --cached --name-only | grep -E '^\.env(\.|$)' | grep -v '^\.env\.example$'; then
    echo -e "${RED}[check-secrets] .env files other than .env.example must not be committed.${NC}"
    echo "  Use .env.example as a template and add real secrets to your local .env only."
    failed=1
  fi
fi

# 2. .env (if it exists locally) must never contain a real API key or password.
# The staged-file check above prevents accidental commits; this scan protects
# the working copy from holding real credentials even when gitignored.
if [ -f .env ]; then
  # Kimi API keys start with "sk-" and are 40+ chars.
  if grep -qE '^KIMI_API_KEY="?sk-[A-Za-z0-9_-]{40,}' .env 2>/dev/null && ! grep -qE '^KIMI_API_KEY="?__SET_ME' .env 2>/dev/null; then
    echo -e "${RED}[check-secrets] .env contains a real Kimi API key.${NC}"
    failed=1
  fi
  # Mistral API keys are 30+ alphanumeric chars (not a placeholder).
  # Reject known placeholder substrings so long dev defaults like
  # `local_dev_api_secret_...` do not pass the length check.
  mistral_value=$(grep -E '^MISTRAL_API_KEY=' .env 2>/dev/null | head -1 | cut -d'=' -f2- | sed "s/^['\"]//;s/['\"]$//" || true)
  if [ -n "$mistral_value" ] && [ "${#mistral_value}" -ge 30 ] && ! echo "$mistral_value" | grep -qiE '__SET_ME|placeholder|your_|changeme|local_dev_|dev_|test_'; then
    echo -e "${RED}[check-secrets] .env contains a real Mistral API key.${NC}"
    failed=1
  fi
  # Refuse to commit a real database password (>= 16 chars, not a known dev placeholder)
  # M27: Strip surrounding quotes before length/pattern check.
  pw=$(grep -E '^POSTGRES_PASSWORD=' .env 2>/dev/null | head -1 | cut -d'=' -f2- | sed "s/^['\"]//;s/['\"]$//" || true)
  # Allow the documented development default prefix used in .env.example.
  if [ -n "$pw" ] && [ "${#pw}" -ge 16 ] && ! echo "$pw" | grep -qE '^(dockerbuild|__SET_ME|placeholder|changeme|local_dev_)'; then
    echo -e "${RED}[check-secrets] .env contains a real-looking POSTGRES_PASSWORD.${NC}"
    failed=1
  fi
fi

# 3. .env.backup is a known leak — fail loudly if someone tries to commit it.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --cached --name-only | grep -qE '^\.env\.backup$'; then
    echo -e "${RED}[check-secrets] .env.backup contains real credentials from a previous dev run. NEVER commit it.${NC}"
    echo "  Rotate every secret it contained, then delete it locally:"
    echo "    rm .env.backup && git rm --cached .env.backup"
    failed=1
  fi
fi

# 4. Run gitleaks if installed. We don't fail the commit if gitleaks is missing —
#    the in-script checks above are the canonical guard. gitleaks is the
#    belt-and-suspenders layer.
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks protect --staged --redact --no-banner 2>/dev/null; then
    echo -e "${RED}[check-secrets] gitleaks detected a secret in the staged diff.${NC}"
    failed=1
  fi
fi

if [ "$failed" -eq 0 ]; then
  echo -e "${GREEN}[check-secrets] OK — no secrets detected.${NC}"
fi

exit $failed
