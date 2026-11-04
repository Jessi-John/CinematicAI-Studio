import { describe, it, expect } from 'vitest';
import { convertStory, type DbStoryFull } from './converters.js';

function makeDbStory(overrides: Partial<DbStoryFull> = {}): DbStoryFull {
  return {
    id: 's1',
    title: 'T',
    genre: 'adventure',
    status: 'complete',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    episodes: [],
    characters: [],
    environments: [],
    embedding: [],
    targetAudience: null,
    qualityScore: null,
    qualityGrade: null,
    humanizationScore: null,
    monetizationScore: null,
    viralityScore: null,
    retentionScore: null,
    hookStrength: null,
    qualityRecommendations: [],
    qualityIssues: [],
    algorithmTips: [],
    alternateTitles: [],
    episodeCount: 0,
    sceneCount: 0,
    youtubeSeo: null,
    ...overrides,
  };
}

describe('L18: convertStory does not fabricate metadata', () => {
  it('omits score fields when the DB columns are null', () => {
    const story = convertStory(makeDbStory());
    expect(story.metadata.viralityScore).toBeUndefined();
    expect(story.metadata.monetizationScore).toBeUndefined();
    expect(story.metadata.retentionScore).toBeUndefined();
    expect(story.metadata.hookStrength).toBeUndefined();
    expect(story.metadata.targetAudience).toBe('general');
  });

  it('reflects the persisted score columns exactly', () => {
    const story = convertStory(
      makeDbStory({
        monetizationScore: 82,
        viralityScore: 91,
        retentionScore: 74,
        hookStrength: 88,
      })
    );
    expect(story.metadata.monetizationScore).toBe(82);
    expect(story.metadata.viralityScore).toBe(91);
    expect(story.metadata.retentionScore).toBe(74);
    expect(story.metadata.hookStrength).toBe(88);
  });

  it('reflects persisted prompt createdAt timestamps instead of fabricating an epoch', () => {
    const imagePromptCreatedAt = new Date('2025-03-15T12:00:00.000Z');
    const videoPromptCreatedAt = new Date('2025-03-15T12:30:00.000Z');
    const story = convertStory(
      makeDbStory({
        episodes: [
          {
            id: 'e1',
            number: 1,
            title: 'Episode 1',
            synopsis: 'Synopsis',
            hook: 'Hook',
            cliffhanger: 'Cliffhanger',
            duration: 60,
            scenes: [
              {
                id: 'sc1',
                number: 1,
                duration: 60,
                narrationText: 'Narration',
                narrationEmotion: 'neutral',
                imagePromptContent: 'image content',
                imagePromptVersion: 1,
                imagePromptCreatedAt,
                videoPromptContent: 'video content',
                videoPromptVersion: 1,
                videoPromptCreatedAt,
              },
            ],
          },
        ],
      })
    );
    expect(story.episodes[0]?.scenes[0]?.imagePrompt.createdAt).toBe(imagePromptCreatedAt.toISOString());
    expect(story.episodes[0]?.scenes[0]?.videoPrompt.createdAt).toBe(videoPromptCreatedAt.toISOString());
  });

  it('omits prompt createdAt when the DB columns are null', () => {
    const story = convertStory(
      makeDbStory({
        episodes: [
          {
            id: 'e1',
            number: 1,
            title: 'Episode 1',
            synopsis: 'Synopsis',
            hook: 'Hook',
            cliffhanger: 'Cliffhanger',
            duration: 60,
            scenes: [
              {
                id: 'sc1',
                number: 1,
                duration: 60,
                narrationText: 'Narration',
                narrationEmotion: 'neutral',
                imagePromptContent: 'image content',
                imagePromptVersion: 1,
                videoPromptContent: 'video content',
                videoPromptVersion: 1,
              },
            ],
          },
        ],
      })
    );
    expect(story.episodes[0]?.scenes[0]?.imagePrompt.createdAt).toBeUndefined();
    expect(story.episodes[0]?.scenes[0]?.videoPrompt.createdAt).toBeUndefined();
  });
});
