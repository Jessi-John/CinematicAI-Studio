/**
 * Sanitizes user-provided strings before interpolation into AI prompts.
 * Prevents prompt injection by escaping control characters, JSON metacharacters,
 * and bounding input length.
 *
 * Use BEFORE every user input is interpolated into a prompt string.
 */
export function sanitizeForPrompt(input: string | null | undefined): string {
  if (input == null) return '';

  if (typeof input !== 'string') {
    input = String(input);
  }

  return input
    .slice(0, 2000) // length bound — prevents memory exhaustion
    // eslint-disable-next-line no-control-regex -- security: strip control chars to prevent prompt injection
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control characters (0x00-0x1F + DEL)
    .replace(/\\/g, '\\\\')                         // escape backslashes first
    .replace(/"/g, '\\"')                           // escape double quotes
    .replace(/'/g, "\\'")                           // escape single quotes
    .replace(/`/g, '\\`')                           // escape backticks
    .replace(/\${/g, '\\${')                        // escape template literal syntax
    .trim();
}

/**
 * Sanitizes an array of strings for prompt use.
 * Returns a new array; does not mutate the original.
 */
export function sanitizeArrayForPrompt(inputs: string[]): string[] {
  return inputs.map((v) => sanitizeForPrompt(v));
}