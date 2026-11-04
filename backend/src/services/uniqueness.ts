import { prisma } from '../database/prisma.js';
import type { Genre } from './types.js';

export interface StoryAnalysis {
  usedCharacterNames: Set<string>;
  usedCharacterFullNames: Set<string>;
  usedEnvironmentNames: Set<string>;
  usedTitleWords: Set<string>;
  usedHooks: Set<string>;
  usedCliffhangers: Set<string>;
  genreThemes: Map<Genre, string[]>;
}

const COMMON_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was',
  'are','were','been','be','have','has','had','do','does','did','will','would','could','should',
  'may','might','must','shall','can','need','journey','story','tale','episode','part','chapter',
]);

const MAX_STORIES_TO_ANALYZE = 1000;
const BATCH_SIZE = 200;
// M6: Serializable isolation can fail with P2034 (serialization_failure)
// when two concurrent transactions conflict. Retry up to 3 times with a
// short backoff before giving up.
const SERIALIZABLE_MAX_RETRIES = 3;
const SERIALIZABLE_BACKOFF_MS = 50;

export async function analyzeExistingStories(): Promise<StoryAnalysis> {
  const analysis: StoryAnalysis = {
    usedCharacterNames: new Set(),
    usedCharacterFullNames: new Set(),
    usedEnvironmentNames: new Set(),
    usedTitleWords: new Set(),
    usedHooks: new Set(),
    usedCliffhangers: new Set(),
    genreThemes: new Map(),
  };

  // BIZ-005: Wrap in transaction with Snapshot isolation so concurrent jobs
  // get consistent snapshots and cannot see each other's uncommitted writes.
  // This prevents two jobs starting simultaneously from reading identical data.
  // M30: RepeatableRead gives the same snapshot guarantee as Serializable for
  // this READ-ONLY 1000-story scan, WITHOUT the P2034 serialization failures
  // that previously failed stage 1 under concurrent write load. (The comment
  // above said "Snapshot isolation" while the code used Serializable.)
  let lastError: unknown;
  for (let retry = 0; retry < SERIALIZABLE_MAX_RETRIES; retry++) {
    try {
      await prisma().$transaction(async (tx) => {
    let cursor: string | undefined;
    let fetched = 0;

    while (fetched < MAX_STORIES_TO_ANALYZE) {
      const result = await tx.story.findMany({
        take: BATCH_SIZE,
        // M4: Cursor pagination requires a deterministic orderBy. Without it the
        // database may return rows in any order, so the (skip:1, cursor) boundary
        // is nondeterministic — stories can be skipped or double-counted across
        // batches. Order by the cursor column (id) for stable page boundaries.
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          genre: true,
          title: true,
          theme: true,
          characters: { select: { name: true } },
          environments: { select: { name: true } },
          episodes: { select: { hook: true, cliffhanger: true } },
        },
      });

      if (result.length === 0) break;

      for (const story of result) {
        for (const char of story.characters) {
          for (const part of char.name.toLowerCase().split(' ')) {
            if (part.length > 2) analysis.usedCharacterNames.add(part);
          }
          const full = char.name.toLowerCase().replace(/\s+/g, ' ').trim();
          if (full.length > 2) analysis.usedCharacterFullNames.add(full);
        }
        for (const env of story.environments) {
          analysis.usedEnvironmentNames.add(env.name.toLowerCase());
        }
        // M30: tokenize title words the same way concept-registry.ts does
        // (strip non-alphanumerics) — whitespace-only splitting kept
        // punctuation attached ("echo," vs "echo"), so post-completion
        // avoidance and in-flight claims disagreed at punctuation boundaries.
        for (const word of story.title.toLowerCase().split(/[^a-z0-9]+/)) {
          if (word.length > 3 && !COMMON_WORDS.has(word)) analysis.usedTitleWords.add(word);
        }
        // M7: Use Set.has() (O(1)) instead of Array.includes() (O(n)) for
        // membership checks. Previously usedHooks/usedCliffhangers were
        // string[] and included() was called inside a loop over up to 1000
        // stories × 10 episodes = 10,000 entries → O(n²) up to 100M comparisons.
        for (const ep of story.episodes) {
          if (ep.hook) analysis.usedHooks.add(ep.hook);
          if (ep.cliffhanger) analysis.usedCliffhangers.add(ep.cliffhanger);
        }
        if (!analysis.genreThemes.has(story.genre as Genre)) {
          analysis.genreThemes.set(story.genre as Genre, []);
        }
        if (story.theme) {
          analysis.genreThemes.get(story.genre as Genre)?.push(story.theme);
        }
      }

      cursor = result[result.length - 1]!.id;
      fetched += result.length;
      if (result.length < BATCH_SIZE) break;
    }
  }, { isolationLevel: 'RepeatableRead' });
      return analysis;
    } catch (err) {
      lastError = err;
      // P2034 is Prisma's code for serialization_failure
      const code = (err as { code?: string }).code;
      if (code !== 'P2034' && retry < SERIALIZABLE_MAX_RETRIES - 1) {
        // Non-serialization errors should not be retried
        throw err;
      }
      if (retry < SERIALIZABLE_MAX_RETRIES - 1) {
        await new Promise<void>((r) => setTimeout(r, SERIALIZABLE_BACKOFF_MS * (retry + 1)));
      }
    }
  }
  throw lastError;
}

export function generateUniqueStoryPrompt(
  genre: Genre,
  analysis: StoryAnalysis,
  preferredSeed?: string
): { theme: string; constraints: string[] } {
  const constraints: string[] = [];

  if (analysis.usedCharacterNames.size > 0) {
    constraints.push(
      `Avoid character name patterns: ${Array.from(analysis.usedCharacterNames).slice(0, 10).join(', ')}`
    );
  }
  if (analysis.usedEnvironmentNames.size > 0) {
    constraints.push(
      `Avoid environment names: ${Array.from(analysis.usedEnvironmentNames).slice(0, 5).join(', ')}`
    );
  }
  if (analysis.usedTitleWords.size > 0) {
    constraints.push(
      `Avoid title words: ${Array.from(analysis.usedTitleWords).slice(0, 15).join(', ')}`
    );
  }

  const genreThemes = getGenreThemes(genre);
  const usedThemes = analysis.genreThemes.get(genre) || [];
  const available = genreThemes.filter((t) => !usedThemes.includes(t));

  const theme: string | undefined =
    preferredSeed?.trim() ||
    (available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : genreThemes[Math.floor(Math.random() * genreThemes.length)]);
  const finalTheme = theme ?? 'default';

  return { theme: finalTheme, constraints };
}

function getGenreThemes(genre: Genre): string[] {
  const themes: Record<Genre, string[]> = {
    fantasy: [
      'ancient prophecy awakening',
      'forgotten magic returning',
      'battle for a mystical kingdom',
      'quest to save a dying world',
      'chosen one\'s difficult journey',
    ],
    adventure: [
      'treasure hunt across continents',
      'survival in uncharted territory',
      'race against rival explorers',
      'lost city discovery',
      'journey through dangerous wilderness',
    ],
    romance: [
      'unexpected connection across worlds',
      'second chance at love',
      'forbidden love defying tradition',
      'love triangle with a twist',
      'reunion after years apart',
    ],
    horror: [
      'ancient evil awakening',
      'haunted location revelation',
      'surviving supernatural entities',
      'dark secret of an old house',
      'creature from the depths',
    ],
    mystery: [
      'crime that seems impossible',
      'detective with unique ability',
      'hidden truth finally revealed',
      'cold case reopened',
      'investigation with dangerous obstacles',
    ],
    // M30: the remaining 16 genres previously all shared the single theme
    // 'new unique adventure', guaranteeing theme collisions.
    thriller: [
      'race against a hidden conspiracy',
      'protagonist framed for a crime',
      'countdown to a looming catastrophe',
      'betrayal inside the trusted circle',
      'hunted by a relentless pursuer',
    ],
    'sci-fi': [
      'first contact gone wrong',
      'AI awakening with unintended goals',
      'colony ship losing its way',
      'time anomaly rewriting the present',
      'corporate dystopia uprising',
    ],
    drama: [
      'family secret surfacing at a reunion',
      'rebuilding life after public failure',
      'estranged siblings inheriting a burden',
      'mentor and student clashing over legacy',
      'small choice with lifelong consequences',
    ],
    comedy: [
      'worst possible day keeps escalating',
      'undercover plan with constant near-misses',
      'rivals forced to share a small space',
      'ordinary job with absurd coworkers',
      'fake identity that becomes too real',
    ],
    action: [
      'one last mission before retirement',
      'escort a target through hostile territory',
      'underdog versus an unbeatable rival',
      'heist where everything goes wrong',
      'defense of a place that must not fall',
    ],
    emotional: [
      'letters never meant to be read',
      'caring for someone who forgets you',
      'last summer before everything changes',
      'reunion that comes one day too late',
      'promise kept across decades',
    ],
    mythology: [
      'mortal caught in a gods\' wager',
      'forgotten deity reclaiming a domain',
      'hero undertaking the twelfth labor',
      'trickster spirit owing a debt',
      'oracle whose visions always come true',
    ],
    historical: [
      'codebreaker hiding work in plain sight',
      'smuggler on a changing frontier',
      ' apprentice caught between guilds and crown',
      'war letter that changes two families',
      'explorer mapping a disputed coast',
    ],
    'slice-of-life': [
      'quiet season in a small town',
      'new neighbor with a strange routine',
      'repairing an old family shop',
      'garden tended by two generations',
      'morning shift at the last diner in town',
    ],
    'dark-fantasy': [
      'crown that feeds on its wearer',
      'knight sworn to a dying god',
      'village that must offer one soul',
      'shadow that learned to speak',
      'bargain written in someone else\'s blood',
    ],
    psychological: [
      'memory that might not be yours',
      'therapist who knows too much',
      'two accounts of the same night',
      'obsession mistaken for intuition',
      'room that only exists on Tuesdays',
    ],
    inspirational: [
      'comeback after everyone counted them out',
      'teacher who refuses to give up on one student',
      'small-town team reaching the final',
      'letter that restarts a stalled dream',
      'first step after years of standing still',
    ],
    kids: [
      'talking pet with a big secret',
      'backyard that becomes a jungle at dusk',
      'new kid with an unusual best friend',
      'school project that comes alive',
      'map found inside a library book',
    ],
    survival: [
      'stranded with dwindling supplies',
      'winter crossing after the crash',
      'island that changes at night',
      'expedition split by the storm',
      'signal fire nobody wants to light',
    ],
    'anime-style': [
      'transfer student hiding an overwhelming power',
      'club that accidentally summons a spirit',
      'rival who becomes an uneasy ally',
      'tournament with a secret final round',
      'ordinary city with a hidden magical layer',
    ],
    'viral-trend': [
      'challenge that spirals out of control',
      'creator whose fake persona becomes real',
      'live stream interrupted by something impossible',
      'trend that predicts real events',
      'overnight fame with a hidden cost',
    ],
  };
  return themes[genre];
}
