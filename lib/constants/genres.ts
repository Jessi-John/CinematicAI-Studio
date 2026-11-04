export const GENRES = [
  { value: 'fantasy', label: 'Fantasy', emoji: '🏰' },
  { value: 'adventure', label: 'Adventure', emoji: '🗺️' },
  { value: 'romance', label: 'Romance', emoji: '💕' },
  { value: 'horror', label: 'Horror', emoji: '👻' },
  { value: 'mystery', label: 'Mystery', emoji: '🔍' },
  { value: 'thriller', label: 'Thriller', emoji: '😱' },
  { value: 'sci-fi', label: 'Sci-Fi', emoji: '🚀' },
  { value: 'drama', label: 'Drama', emoji: '🎭' },
  { value: 'comedy', label: 'Comedy', emoji: '😂' },
  { value: 'action', label: 'Action', emoji: '💥' },
  { value: 'emotional', label: 'Emotional', emoji: '🥲' },
  { value: 'mythology', label: 'Mythology', emoji: '⚡' },
  { value: 'historical', label: 'Historical', emoji: '🏛️' },
  { value: 'slice-of-life', label: 'Slice of Life', emoji: '🌸' },
  { value: 'dark-fantasy', label: 'Dark Fantasy', emoji: '🌑' },
  { value: 'psychological', label: 'Psychological', emoji: '🧠' },
  { value: 'inspirational', label: 'Inspirational', emoji: '✨' },
  { value: 'kids', label: 'Kids', emoji: '🧒' },
  { value: 'survival', label: 'Survival', emoji: '🏕️' },
  { value: 'anime-style', label: 'Anime-style', emoji: '🎌' },
  { value: 'viral-trend', label: 'Viral Trend', emoji: '🔥' },
] as const;

export type Genre = (typeof GENRES)[number]['value'];

/** Runtime guard: checks whether an API response genre matches a known value. */
export function isValidGenre(genre: string): genre is Genre {
  return GENRES.some((g) => g.value === genre);
}

export const GENRE_MAP: Record<Genre, { value: Genre; label: string; emoji: string }> = {
  fantasy: { value: 'fantasy', label: 'Fantasy', emoji: '🏰' },
  adventure: { value: 'adventure', label: 'Adventure', emoji: '🗺️' },
  romance: { value: 'romance', label: 'Romance', emoji: '💕' },
  horror: { value: 'horror', label: 'Horror', emoji: '👻' },
  mystery: { value: 'mystery', label: 'Mystery', emoji: '🔍' },
  thriller: { value: 'thriller', label: 'Thriller', emoji: '😱' },
  'sci-fi': { value: 'sci-fi', label: 'Sci-Fi', emoji: '🚀' },
  drama: { value: 'drama', label: 'Drama', emoji: '🎭' },
  comedy: { value: 'comedy', label: 'Comedy', emoji: '😂' },
  action: { value: 'action', label: 'Action', emoji: '💥' },
  emotional: { value: 'emotional', label: 'Emotional', emoji: '🥲' },
  mythology: { value: 'mythology', label: 'Mythology', emoji: '⚡' },
  historical: { value: 'historical', label: 'Historical', emoji: '🏛️' },
  'slice-of-life': { value: 'slice-of-life', label: 'Slice of Life', emoji: '🌸' },
  'dark-fantasy': { value: 'dark-fantasy', label: 'Dark Fantasy', emoji: '🌑' },
  psychological: { value: 'psychological', label: 'Psychological', emoji: '🧠' },
  inspirational: { value: 'inspirational', label: 'Inspirational', emoji: '✨' },
  kids: { value: 'kids', label: 'Kids', emoji: '🧒' },
  survival: { value: 'survival', label: 'Survival', emoji: '🏕️' },
  'anime-style': { value: 'anime-style', label: 'Anime-style', emoji: '🎌' },
  'viral-trend': { value: 'viral-trend', label: 'Viral Trend', emoji: '🔥' },
};

export const STORY_COLORS: Record<Genre, string> = {
  fantasy: '#9333EA',
  adventure: '#F59E0B',
  romance: '#EC4899',
  horror: '#DC2626',
  mystery: '#6366F1',
  thriller: '#DC2626',
  'sci-fi': '#06B6D4',
  drama: '#8B5CF6',
  comedy: '#FAB005',
  action: '#EF4444',
  emotional: '#F472B6',
  mythology: '#FBBF24',
  historical: '#92400E',
  'slice-of-life': '#34D399',
  'dark-fantasy': '#581C87',
  psychological: '#4B5563',
  inspirational: '#10B981',
  kids: '#60A5FA',
  survival: '#65A30D',
  'anime-style': '#A855F7',
  'viral-trend': '#F97316',
};
