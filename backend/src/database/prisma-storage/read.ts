import { prisma } from '../prisma.js';
import { convertStory } from './converters.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStoryInclude = Record<string, any>;

const FULL_INCLUDE: AnyStoryInclude = {
  episodes: {
    include: {
      scenes: {
        orderBy: { number: 'asc' },
        take: 100,
      },
    },
    // L10: `take` without orderBy returns a nondeterministic subset — order
    // episodes so the cap is at least stable.
    orderBy: { number: 'asc' },
    take: 20,
  },
  characters: true,
  environments: true,
  youtubeSeo: true,
};

const SUBTITLE_INCLUDE: AnyStoryInclude = {
  episodes: {
    include: {
      scenes: {
        orderBy: { number: 'asc' },
        take: 100,
      },
    },
    orderBy: { number: 'asc' },
    take: 20,
  },
};

const SIMILARITY_INCLUDE: AnyStoryInclude = {
  episodes: {
    take: 10,
    select: { number: true, hook: true, cliffhanger: true, synopsis: true },
  },
  characters: { select: { name: true, role: true, description: true } },
};

const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const LIST_SELECT = {
  id: true,
  title: true,
  genre: true,
  seed: true,
  theme: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  targetAudience: true,
  qualityScore: true,
  qualityGrade: true,
  humanizationScore: true,
  qualityRecommendations: true,
  qualityIssues: true,
  algorithmTips: true,
  alternateTitles: true,
  seedStoryId: true,
  episodeCount: true,
  sceneCount: true,
};

const SCENES_PER_LISTING = 50;

export async function getStoriesForSimilarity(limit = 100, userId?: string): Promise<ReturnType<typeof convertStory>[]> {
  const where: Record<string, unknown> = {};
  if (userId) {
    where['userId'] = userId;
  }
  // L11: no status filter by design — duplicate detection must compare against
  // ALL stories (including drafts), otherwise a draft concept could be
  // regenerated into a "duplicate". Documented to prevent a "helpful" future
  // filter from re-introducing the duplicate hole.
  const stories = await prisma().story.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: SIMILARITY_INCLUDE,
  });
  return (stories || []).map((s) => convertStory(s));
}

export async function getAllStories(pagination: { limit?: number; cursor?: string; search?: string; genre?: string; userId?: string; sortBy?: 'newest' | 'oldest' | 'title' }) {
  const { limit = 20, cursor, search, genre, userId, sortBy = 'newest' } = pagination || {};

  // M3 / M41: Generic cursor that supports date-based (newest/oldest) and
  // title-based sorts. Legacy ISO cursors remain accepted for 'newest'.
  // Cursor is base64url(JSON({ sortBy, value, id })) for non-legacy sorts.
  function decodeCursor(raw: string): { sortBy: 'newest' | 'oldest' | 'title'; value: string; id?: string | undefined } | null {
    // Legacy ISO-only cursor (default newest)
    if (isoDateRegex.test(raw) && !isNaN(Date.parse(raw))) {
      return { sortBy: 'newest', value: raw, id: undefined };
    }
    // Legacy composite date cursor: <ISO>_<id>
    const sepIdx = raw.lastIndexOf('_');
    if (sepIdx > 0) {
      const value = raw.slice(0, sepIdx);
      const id = raw.slice(sepIdx + 1) || undefined;
      if (isoDateRegex.test(value) && !isNaN(Date.parse(value))) {
        return { sortBy: 'newest', value, id };
      }
    }
    // JSON base64url cursor
    try {
      const json = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const parsed = JSON.parse(json) as { sortBy?: string; value?: string; id?: string };
      if (typeof parsed.value === 'string' && parsed.value.length > 0) {
        const s = parsed.sortBy as 'newest' | 'oldest' | 'title';
        if (s === 'newest' || s === 'oldest' || s === 'title') {
          return { sortBy: s, value: parsed.value, id: parsed.id };
        }
      }
    } catch {
      // fall through to invalid
    }
    return null;
  }

  let cursorValue: string | undefined;
  let cursorId: string | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded || decoded.sortBy !== sortBy) {
      throw Object.assign(new Error('Invalid cursor for requested sort'), { statusCode: 400 });
    }
    cursorValue = decoded.value;
    cursorId = decoded.id;
  }

  const listWhere: Record<string, unknown> = {};

  if (sortBy === 'newest' || sortBy === 'oldest') {
    if (cursorValue) {
      const cursorDate = new Date(cursorValue);
      if (isNaN(cursorDate.getTime())) {
        throw Object.assign(new Error('Invalid cursor date'), { statusCode: 400 });
      }
      const dateOp = sortBy === 'newest' ? 'lt' : 'gt';
      const idOp = sortBy === 'newest' ? 'lt' : 'gt';
      listWhere['OR'] = [
        { createdAt: { [dateOp]: cursorDate } },
        ...(cursorId ? [{ createdAt: cursorDate, id: { [idOp]: cursorId } }] : []),
      ];
    }
  } else if (sortBy === 'title') {
    if (cursorValue) {
      listWhere['OR'] = [
        { title: { gt: cursorValue } },
        ...(cursorId ? [{ title: cursorValue, id: { gt: cursorId } }] : []),
      ];
    }
  }

  if (search) {
    listWhere['title'] = { contains: search, mode: 'insensitive' };
  }
  if (genre) {
    listWhere['genre'] = genre;
  }
  if (userId) {
    listWhere['userId'] = userId;
  }

  const orderBy = sortBy === 'newest'
    ? [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
    : sortBy === 'oldest'
    ? [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
    : [{ title: 'asc' as const }, { id: 'asc' as const }];

  const stories = [...await prisma().story.findMany({
    where: listWhere,
    take: limit + 1,
    select: { ...LIST_SELECT, youtubeSeo: { select: { viralPotential: true } } },
    orderBy,
  })];
  const hasMore = stories.length > limit;
  if (hasMore) stories.pop();
  const last = stories.length > 0 ? stories[stories.length - 1]! : undefined;

  function encodeCursor(lastItem: typeof last): string {
    if (!lastItem) return '';
    const value = sortBy === 'title' ? lastItem.title : lastItem.createdAt.toISOString();
    return Buffer.from(JSON.stringify({ sortBy, value, id: lastItem.id })).toString('base64url');
  }

  const nextCursor = hasMore && last ? encodeCursor(last) : undefined;

  // PERF-LIST-TOTAL: the COUNT query is the most expensive part of this
  // endpoint at scale, and the UI only reads `total` from the FIRST page
  // (lib/query/stories.ts useInfiniteStories reads pages[0].total) and from
  // the dedicated limit=1 count fetch (useStoryCount). Cursor pages (page 2+)
  // never consume it, so we skip the count entirely when a cursor is present
  // and return `total: null` instead. firstPageOnly consumers must treat
  // null as "unknown beyond this page".
  let total: number | null = null;
  if (!cursorValue) {
    const totalWhere: Record<string, unknown> = {};
    if (search) {
      totalWhere['title'] = { contains: search, mode: 'insensitive' };
    }
    if (genre) {
      totalWhere['genre'] = genre;
    }
    if (userId) {
      totalWhere['userId'] = userId;
    }
    total = await prisma().story.count({ where: totalWhere });
  }
  return {
    stories: stories.map(convertStory),
    total,
    hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export async function getStoryById(id: string, episodeNumber?: number) {
  const include = episodeNumber !== undefined
    ? {
      episodes: {
        where: { number: episodeNumber },
        take: 1,
        include: { scenes: { take: SCENES_PER_LISTING, orderBy: { number: 'asc' } } },
      },
      characters: true,
      environments: true,
      youtubeSeo: true,
    }
    : FULL_INCLUDE;
  const story = await prisma().story.findUnique({
    where: { id },
    include: include,
  });
  return story ? convertStory(story) : null;
}

export async function getStoryForExport(id: string, format: string) {
  const isSubtitle = format === 'ssml' || format === 'srt' || format === 'vtt';
  const include = isSubtitle ? SUBTITLE_INCLUDE : FULL_INCLUDE;
  const story = await prisma().story.findUnique({
    where: { id },
    include,
  });
  return story ? convertStory(story) : null;
}
