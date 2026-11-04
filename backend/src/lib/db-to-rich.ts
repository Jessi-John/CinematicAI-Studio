import type { Prisma } from '@prisma/client';
import type { Character, Environment } from '../services/types.js';

interface DbCharacterMinimal {
  id: string;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  role: string;
  gender?: string;
}

interface DbEnvironmentMinimal {
  id: string;
  name: string;
  description: string;
  type: string;
  timeOfDay: string;
  weather: string;
  mood: string;
  keyFeatures: string[];
  colorPalette: string[];
  lightingSetup: Prisma.JsonValue;
}

export function toRichCharacter(c: DbCharacterMinimal): Character {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    appearance: c.appearance,
    personality: c.personality,
    // L24: validate role like gender — an invalid DB value previously passed
    // through the unchecked cast and poisoned downstream role checks.
    role: (c.role === 'protagonist' || c.role === 'antagonist' || c.role === 'supporting')
      ? c.role as Character['role']
      : 'supporting' as Character['role'],
    gender: (c.gender === 'male' || c.gender === 'female' || c.gender === 'neutral')
      ? c.gender
      : 'neutral',
  };
}

export function toRichEnvironment(e: DbEnvironmentMinimal): Environment {
  const ls = e.lightingSetup;
  const obj =
    ls && typeof ls === 'object' && !Array.isArray(ls) ? (ls as Record<string, unknown>) : {};
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    type: e.type,
    timeOfDay: e.timeOfDay,
    weather: e.weather,
    mood: e.mood,
    keyFeatures: e.keyFeatures || [],
    colorPalette: e.colorPalette || [],
    lighting: {
      primary: typeof obj.primary === 'string' ? obj.primary : '',
      ambient: typeof obj.ambient === 'string' ? obj.ambient : '',
      colorTemperature: typeof obj.colorTemperature === 'string' ? obj.colorTemperature : 'neutral',
      shadows:
        obj.shadows === 'soft' || obj.shadows === 'hard' || obj.shadows === 'dramatic'
          ? (obj.shadows as 'soft' | 'hard' | 'dramatic')
          : 'soft',
    },
  };
}