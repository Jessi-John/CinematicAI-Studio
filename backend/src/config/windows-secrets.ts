/**
 * Windows Credential Manager integration — REMOVED (M29).
 *
 * Previously this module called a PowerShell script (credential-manager.ps1)
 * to retrieve DPAPI-encrypted secrets from the Windows Credential Manager
 * store. The script was a local-dev convenience for Windows users.
 *
 * The script was never required for Docker deployment (loadWindowsSecrets
 * returns immediately on non-Windows platforms). However, it created a
 * fragile dependency on a file that was hard to maintain cross-platform
 * (the original was accidentally deleted and could not be recovered).
 *
 * Root-cause fix: remove the dependency entirely. The .env file (loaded by
 * load-env.ts after this returns) is now the canonical source of secrets
 * for all platforms. Windows local developers use the standard .env file
 * like everyone else — the DPAPI integration was a nice-to-have that
 * added complexity without clear benefit since .env files are already
 * in .gitignore.
 *
 * This file is kept as a no-op stub so that any remaining imports compile.
 * New code should not import from this module.
 */
export function loadWindowsSecrets(): void {
  // No-op. The .env file is loaded by load-env.ts after this returns.
}
