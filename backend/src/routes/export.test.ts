/**
 * Export route unit tests — MEDIUM #49.
 *
 * Tests POST /api/stories/:id/export in isolation with mocked storage and
 * rate-limit dependencies. Covers validation, ownership, all formats, and the
 * prompts-only × subtitle-format rejection.
 */

import express from 'express';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type http from 'http';
import type { Story } from '../services/types.js';
import { getStoryForExport } from '../database/prisma-storage.js';

vi.mock('../middleware/rate-limit.js', () => ({
  exportLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../database/prisma-storage.js', () => ({
  getStoryForExport: vi.fn(),
}));

const STORY_ID = 'a01c5b89-0dc3-44f8-b8ab-d7437a7064e6';

function makeStory(): Story {
  return {
    id: STORY_ID,
    title: 'Test Story',
    genre: 'adventure',
    status: 'complete',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    episodes: [
      {
        id: 'ep-1',
        number: 1,
        title: 'Episode 1',
        synopsis: 'Episode synopsis.',
        hook: 'Episode hook.',
        cliffhanger: 'Episode cliffhanger.',
        duration: 60,
        voiceoverText: 'Voiceover text.',
        musicSuggestions: ['epic'],
        soundDesign: ['ambience'],
        scenes: [
          {
            id: 'sc-1',
            number: 1,
            duration: 30,
            narration: {
              id: 'sc-1',
              text: 'Scene narration text.',
              emotion: 'determined',
              timing: { totalDuration: 30, wordsPerMinute: 150, charactersPerMinute: 900 },
            },
            imagePrompt: {
              id: 'sc-1',
              type: 'image',
              content: 'Image prompt.',
              version: 1,
              createdAt: new Date().toISOString(),
            },
            videoPrompt: {
              id: 'sc-1',
              type: 'video',
              content: 'Video prompt.',
              version: 1,
              createdAt: new Date().toISOString(),
            },
            cameraDirection: {
              type: 'wide',
              movement: 'pan',
              angle: 'low',
              lens: 'standard',
            },
            emotionalIntensity: 8,
            transitionType: 'cut',
            characterState: {
              characterId: '',
              position: 'center frame',
              action: 'standing',
              emotion: 'neutral',
              expression: 'calm',
              bodyLanguage: 'natural',
            },
            environmentState: {
              environmentId: '',
              timeOfDay: 'day',
              weather: 'clear',
              lighting: 'natural',
              atmosphere: 'calm',
              ambientSounds: [],
            },
          },
        ],
      },
    ],
    characters: [],
    environments: [],
    metadata: {
      totalEpisodes: 1,
      totalScenes: 1,
      estimatedDuration: 60,
      targetAudience: 'general',
      monetizationScore: 85,
      viralityScore: 92,
      retentionScore: 88,
      hookStrength: 90,
    },
  } as unknown as Story;
}

describe('export route', () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;
  let requestUser = { sub: 'user-1', role: 'user' };

  beforeAll(async () => {
    const { exportRouter } = await import('./export.js');
    app = express();
    app.use(express.json());
    app.use('/api/stories', (req, _res, next) => {
      // Simulate authenticated user middleware for ownership checks.
      (req as unknown as Record<string, unknown>).user = requestUser;
      next();
    }, exportRouter);

    server = app.listen(0);
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
  });

  beforeEach(() => {
    requestUser = { sub: 'user-1', role: 'user' };
    vi.mocked(getStoryForExport).mockReset();
  });

  async function postExport(id: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/stories/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 400 for an invalid story id', async () => {
    const res = await postExport('not-a-valid-uuid', { format: 'json' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  it('returns 404 when the story does not exist', async () => {
    vi.mocked(getStoryForExport).mockResolvedValue(null);
    const res = await postExport(STORY_ID, { format: 'json' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Story not found');
  });

  it('returns 403 when the user does not own the story', async () => {
    requestUser = { sub: 'other-user', role: 'user' };
    vi.mocked(getStoryForExport).mockResolvedValue(makeStory());
    const res = await postExport(STORY_ID, { format: 'json' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Forbidden');
  });

  it('returns 400 for prompts-only content with subtitle formats', async () => {
    for (const format of ['ssml', 'srt', 'vtt']) {
      const res = await postExport(STORY_ID, { format, content: 'prompts-only' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Invalid export configuration');
    }
  });

  describe('format responses', () => {
    const cases: Array<{ format: string; contentType: string; expected: RegExp }> = [
      { format: 'json', contentType: 'application/json', expected: /"title":\s*"Test Story"/ },
      { format: 'csv', contentType: 'text/csv', expected: /Episode,Scene,Narration/ },
      { format: 'txt', contentType: 'text/plain', expected: /Test Story/ },
      { format: 'ssml', contentType: 'application/ssml+xml', expected: /<speak/ },
      { format: 'srt', contentType: 'application/x-subrip', expected: /Scene narration text/ },
      { format: 'vtt', contentType: 'text/vtt', expected: /WEBVTT/ },
    ];

    for (const { format, contentType, expected } of cases) {
      it(`returns correct content for format=${format}`, async () => {
        vi.mocked(getStoryForExport).mockResolvedValue(makeStory());
        const res = await postExport(STORY_ID, { format });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain(contentType);
        expect(res.headers.get('Content-Disposition')).toContain('attachment');
        const text = await res.text();
        expect(text).toMatch(expected);
      });
    }
  });
});
