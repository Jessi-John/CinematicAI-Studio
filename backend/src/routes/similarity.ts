import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { getStoriesForSimilarity } from '../database/prisma-storage.js';
import { safeJsonParse } from '../lib/sanitize.js';
import { generateWithMistral, runWithAIPipelineContext } from '../lib/ai-client.js';
import { aiLimiter } from '../middleware/rate-limit.js';
import { logger } from '../services/logger.js';
import { sanitizeForPrompt } from '../lib/sanitize-prompt.js';
import type { ApiResponse } from '../services/types.js';
import type { AuthenticatedRequest } from '../middleware/jwt.js';

const router = Router();

const similaritySchema = z.object({
  seed: z.string().max(500).optional(),
  genre: z.string().max(50),
});

interface ScoredStory {
  id: string;
  title: string;
  score: number;
}

function calculateTextSimilarity(t1: string, t2: string): number {
  const w1 = new Set(t1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const w2 = new Set(t2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (w1.size === 0 || w2.size === 0) return 0;
  let intersect = 0;
  for (const w of w1) if (w2.has(w)) intersect += 1;
  const union = w1.size + w2.size - intersect;
  return union > 0 ? intersect / union : 0;
}

router.get(
  '/',
  aiLimiter,
  asyncHandler(async (req, res) => {
    const parsed = similaritySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request. Expected query params: genre (required) and seed (optional).',
        details: parsed.error.issues.map((i) => i.message),
      } as unknown as ApiResponse<null>);
    }

    const { seed, genre } = parsed.data;

    // H2: Scope similarity search to the caller's own stories only.
    // Previously getStoriesForSimilarity(100) returned the 100 most recent
    // stories across ALL users, exposing other users' titles/seeds/themes/hooks.
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.sub;
    // M26-parity: fail closed when the authenticated subject is somehow
    // absent. With no userId, getStoriesForSimilarity would fall back to an
    // unscoped query (exposing other users' titles) — the exact bug H2 fixed.
    // The stories list route (stories.ts, M26) enforces the same guard.
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' } satisfies ApiResponse<null>);
    }

    // Fix: Use lightweight similarity query instead of getAllStories({ limit: 1000 }).
    // The old call loaded full episode/scene/character/environment hierarchy for 1000
    // stories, consuming significant heap. getStoriesForSimilarity loads only the fields
    // needed for seed/theme/hook/cliffhanger comparison.
    const sameGenreStories = (await getStoriesForSimilarity(100, userId)).filter((s) => s.genre === genre);

    const seedPhrase = seed || '';
    const similarities: ScoredStory[] = sameGenreStories.map((story) => {
      const seedSim = seed && story.seed ? calculateTextSimilarity(seed, story.seed) : 0;
      const themeSim = story.theme ? calculateTextSimilarity(seedPhrase, story.theme) : 0;

      let structuralSim = 0;
      if (story.episodes.length > 0) {
        const hooks = story.episodes.map((ep) => ep.hook).join(' ');
        const cliffs = story.episodes.map((ep) => ep.cliffhanger).join(' ');
        structuralSim = Math.max(
          calculateTextSimilarity(seedPhrase, hooks),
          calculateTextSimilarity(seedPhrase, cliffs)
        );
      }

      const max = Math.max(seedSim, themeSim, structuralSim * 0.5);
      return {
        id: story.id,
        title: story.title,
        score: Math.round(max * 100) / 100,
      };
    });

    similarities.sort((a, b) => b.score - a.score);

    const threshold = 0.6;
    const clearMatches = similarities.filter((s) => s.score >= 0.8);
    const borderline = similarities.filter((s) => s.score >= 0.4 && s.score < 0.8);

    const refined: ScoredStory[] = [...clearMatches];

    if (borderline.length > 0 && seed) {
      try {
        const safeSeed = sanitizeForPrompt(seed);
        const safeGenre = sanitizeForPrompt(genre);
        const ctx = borderline.slice(0, 3).map((s) => `Title: ${s.title}`).join('\n');

        const systemPrompt =
          'You are a story similarity analyzer. Compare story concepts semantically, not just by word overlap.';
        const userPrompt = `Given a new story concept:
Seed: ${safeSeed}
Genre: ${safeGenre}

Compare it against these existing stories (titles only):
${ctx}

Consider plot structure, character archetypes, theme overlap, setting, and narrative arcs.

Return ONLY valid JSON, no extra text:
{
  "similarityScores": [
    {"id": "story-id", "score": 0.0-1.0}
  ]
}`;

        const aiResponse = await runWithAIPipelineContext(
          authReq.requestId ?? `similarity-${Date.now()}`,
          null,
          () => generateWithMistral(systemPrompt, userPrompt)
        );

        try {
          const parsedAi = safeJsonParse<{
            similarityScores?: Array<{ id?: string; score?: number }>;
          }>(aiResponse);
          if (Array.isArray(parsedAi.similarityScores)) {
            for (const aiScore of parsedAi.similarityScores) {
              if (!aiScore.id || typeof aiScore.score !== 'number') continue;
              const existing = refined.find((s) => s.id === aiScore.id);
              if (existing) {
                existing.score = Math.max(existing.score, aiScore.score);
              } else {
                const orig = borderline.find((s) => s.id === aiScore.id);
                if (orig) {
                  refined.push({ id: orig.id, title: orig.title, score: aiScore.score });
                }
              }
            }
          }
        } catch {
          // Ignore - fall back to lexical-only scores already in `refined`.
        }
      } catch (err) {
        logger.warn({ err }, 'AI similarity refinement failed, lexical only');
      }
    }

    refined.sort((a, b) => b.score - a.score);
    const similarStories = refined.filter((s) => s.score >= threshold);

    return res.json({
      success: true,
      data: {
        isSimilar: similarStories.length > 0,
        score: similarStories[0]?.score ?? 0,
        similarStories: similarStories.slice(0, 5),
      },
    });
  })
);

export const similarityRouter = router;
