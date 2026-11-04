import type { GenerationProgress, GenerationStage } from '@/types';

export interface GenerationStep {
  stage: GenerationStage;
  label: string;
  description: string;
  progress: number;
  icon: string;
}

// M40: Single source of truth for the progress tracker. Every stage the
// backend pipeline emits (verified in pipeline stage files + orchestrator) is
// represented, so `findIndex` in GenerationModal never returns -1 and the user
// always sees an active step.
export const GENERATION_STEPS: GenerationStep[] = [
  {
    stage: 'seed_evaluation',
    label: 'Evaluating Seed',
    description: 'Checking the seed concept against existing stories...',
    progress: 1,
    icon: 'search',
  },
  {
    stage: 'seed_enriched',
    label: 'Enriching Seed',
    description: 'Expanding the seed with genre-specific details...',
    progress: 2,
    icon: 'sparkles',
  },
  {
    stage: 'init',
    label: 'Initializing',
    description: 'Preparing the generation pipeline...',
    progress: 3,
    icon: 'sparkles',
  },
  {
    stage: 'uniqueness',
    label: 'Uniqueness Check',
    description: 'Making sure this story is distinct from existing ones...',
    progress: 6,
    icon: 'search',
  },
  {
    stage: 'blueprint',
    label: 'Creating Blueprint',
    description: 'Generating story premise, characters, and world...',
    progress: 10,
    icon: 'file-text',
  },
  {
    stage: 'character_bible',
    label: 'Character Bible',
    description: 'Fleshing out protagonists, antagonists, and supporting cast...',
    progress: 14,
    icon: 'users',
  },
  {
    stage: 'world_bible',
    label: 'World Bible',
    description: 'Designing the primary setting and supporting environments...',
    progress: 18,
    icon: 'globe',
  },
  {
    stage: 'episodes',
    label: 'Building Episodes',
    description: 'Structuring episodes with hooks and cliffhangers...',
    progress: 45,
    icon: 'film',
  },
  {
    stage: 'building',
    label: 'Building Story',
    description: 'Assembling episodes, scenes, and prompts...',
    progress: 75,
    icon: 'scissors',
  },
  {
    stage: 'humanization',
    label: 'Humanizing',
    description: 'Making narration sound natural...',
    progress: 80,
    icon: 'mic',
  },
  {
    stage: 'quality',
    label: 'Quality Check',
    description: 'Scoring story quality...',
    progress: 85,
    icon: 'check',
  },
  {
    stage: 'seo',
    label: 'YouTube SEO',
    description: 'Writing titles, tags, and descriptions...',
    progress: 90,
    icon: 'image',
  },
  {
    stage: 'copyright',
    label: 'Copyright Sweep',
    description: 'Scanning for IP and monetization risks...',
    progress: 92,
    icon: 'shield',
  },
  {
    stage: 'embedding',
    label: 'Embedding',
    description: 'Computing semantic fingerprint...',
    progress: 93,
    icon: 'file-text',
  },
  {
    stage: 'persisting',
    label: 'Saving',
    description: 'Persisting the final story to the database...',
    progress: 96,
    icon: 'database',
  },
  {
    stage: 'complete',
    label: 'Complete',
    description: 'Your story is ready!',
    progress: 100,
    icon: 'check',
  },
];

export type { GenerationProgress };
