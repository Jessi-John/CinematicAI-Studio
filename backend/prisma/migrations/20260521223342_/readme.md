# Migration 20260521223342_

Adds `isTemplate`, `storyArcType`, and `templateId` columns to the `stories` table, plus an index on `isTemplate`.

## Changes

- `stories.isTemplate` (BOOLEAN, NOT NULL, DEFAULT false) — marks a story as a reusable template
- `stories.storyArcType` (TEXT, NOT NULL, DEFAULT 'classic') — narrative arc classification
- `stories.templateId` (TEXT, nullable) — reference to the source template story
- `CREATE INDEX stories_isTemplate_idx ON stories(isTemplate)`
