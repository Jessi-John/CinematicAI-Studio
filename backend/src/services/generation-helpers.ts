import type { Character, Environment, Story } from '@prisma/client';
import type { CharacterBible } from './character-bible.js';

export function jsonToRecord(json: unknown): Record<string, string> {
    if (!json || typeof json !== 'object' || Array.isArray(json))
        return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string')
            out[k] = v;
    }
    return out;
}

export function buildCharacterBible(protagonist: Character | undefined): CharacterBible | undefined {
    if (!protagonist) return undefined;
    return {
        speechPatterns: protagonist.speechPatterns || 'Kind-hearted, curious',
        clothing: protagonist.clothing || 'simple comfortable clothing',
        facialFeatures: protagonist.facialFeatures || 'Expressive big eyes',
        emotions: protagonist.emotions?.length
            ? protagonist.emotions
            : ['curiosity', 'determination', 'wonder'],
        relationships: jsonToRecord(protagonist.relationships),
        catchphrases: protagonist.catchphrases || [],
        physicalMannerisms: protagonist.physicalMannerisms || 'thoughtful pauses',
        gender: (protagonist.gender === 'male' || protagonist.gender === 'female' || protagonist.gender === 'neutral')
            ? protagonist.gender
            : 'neutral',
    };
}

export function findCharacters(story: Story & { characters: Character[]; environments: Environment[] }) {
    return {
        protagonist: story.characters.find((c) => c.role === 'protagonist'),
        antagonist: story.characters.find((c) => c.role === 'antagonist'),
        supporting: story.characters.find((c) => c.role === 'supporting'),
        environment: story.environments[0],
    };
}


export const GENRE_LIST = [
    'fantasy', 'adventure', 'romance', 'horror', 'mystery', 'thriller',
    'sci-fi', 'drama', 'comedy', 'action', 'emotional', 'mythology',
    'historical', 'slice-of-life', 'dark-fantasy', 'psychological',
    'inspirational', 'kids', 'survival', 'anime-style', 'viral-trend',
] as const;

// L5: DUPLICATE of webhook.ts's WEBHOOK_URL_BLOCKLIST (two sources of
// truth, already drifting — this copy was missing 'metadata.internal').
// Re-export the canonical list from webhook.ts.
export { WEBHOOK_URL_BLOCKLIST as WEBHOOK_BLOCKLIST } from './webhook.js';
