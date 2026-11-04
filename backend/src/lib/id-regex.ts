/**
 * Single source of truth for story/job ID validation.
 * - UUIDs are case-insensitive hex.
 * - CUIDs are Prisma-style lowercase base36 ('c' prefix + 20-28 chars).
 */
export const STORY_ID_REGEX =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|c[0-9a-z]{20,28})$/;
