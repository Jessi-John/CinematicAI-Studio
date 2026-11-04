/**
 * Shared utility for ESM-safe `__dirname` and `__filename` resolution.
 *
 * In CommonJS, `__dirname` and `__filename` are provided by Node.js.
 * In ESM (which this project uses), they are not available. This module
 * provides a consistent way to resolve them from `import.meta.url` so
 * every consumer uses the same pattern and path resolution is stable
 * regardless of the file's location or the process's cwd.
 *
 * Usage:
 * ```ts
 * import { moduleDir, moduleFilename } from './lib/module-path.js';
 * const __dirname = moduleDir(import.meta.url);
 * const __filename = moduleFilename(import.meta.url);
 * ```
 *
 * This prevents per-file `fileURLToPath` boilerplate and the unreliable
 * `typeof __dirname !== 'undefined'` runtime checks that fail in bundlers
 * and non-Node runtimes.
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * Resolve the directory containing the calling module.
 * Equivalent to CommonJS `__dirname` for ESM modules.
 *
 * @param metaUrl - Pass `import.meta.url` from the calling module.
 * @returns Absolute path to the directory containing the caller.
 */
export function moduleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

/**
 * Resolve the absolute file path of the calling module.
 * Equivalent to CommonJS `__filename` for ESM modules.
 *
 * @param metaUrl - Pass `import.meta.url` from the calling module.
 * @returns Absolute path to the caller's file.
 */
export function moduleFilename(metaUrl: string): string {
  return fileURLToPath(metaUrl);
}
