import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { exportLimiter } from '../middleware/rate-limit.js';
import { getStoryForExport } from '../database/prisma-storage.js';
import {
  storyToSSML,
  storyToSRT,
  storyToVTT,
} from '../lib/subtitle-export.js';
import type { ApiResponse, Story, Episode, Scene } from '../services/types.js';
import type { AuthenticatedRequest } from '../middleware/jwt.js';
import { verifyStoryOwnership } from '../middleware/story-ownership.js';
import { STORY_ID_REGEX } from '../lib/id-regex.js';

const router = Router();

const idRegex = STORY_ID_REGEX;

// Fix #36: Cross-validate format × content with .superRefine.
// Subtitle formats (SSML/SRT/VTT) only contain voiceover data — asking for
// a `.srt` of 'prompts-only' produces an empty file with no warning. The
// previous schema accepted the combination silently; the user got a useless
// download. Reject with a precise message so the UI can prompt for a
// sensible alternative.
const exportSchema = z
  .object({
    format: z.enum(['json', 'csv', 'txt', 'ssml', 'srt', 'vtt']).default('json'),
    content: z
      .enum(['full', 'prompts-only', 'voiceover-only', 'scenes-only'])
      .default('full'),
    includeVoiceover: z.boolean().default(true),
    includePrompts: z.boolean().default(true),
    includeMetadata: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    const isSubtitle =
      data.format === 'ssml' || data.format === 'srt' || data.format === 'vtt';
    if (isSubtitle && data.content === 'prompts-only') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: `Format '${data.format}' requires voiceover content. Use 'full' or 'voiceover-only' instead of 'prompts-only'.`,
      });
    }
  });

type ExportFormat = z.infer<typeof exportSchema>['format'];
type ExportContent = z.infer<typeof exportSchema>['content'];

interface ExportFlags {
  voiceover: boolean;
  prompts: boolean;
  metadata: boolean;
  content: ExportContent;
}

router.post(
  '/:id/export',
  exportLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!idRegex.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid story ID format',
      } satisfies ApiResponse<null>);
    }

    const parsed = exportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid export configuration',
      } satisfies ApiResponse<null>);
    }
    const { format, content, includeVoiceover, includePrompts, includeMetadata } = parsed.data;

    // P6: Use getStoryForExport which tailors the DB include to the format.
    // Subtitle formats (SSML/SRT/VTT) only need narration text, so they
    // skip loading characters/environments/youtubeSeo.
    const story = await getStoryForExport(id, format);
    if (!story) {
      return res.status(404).json({
        success: false,
        error: 'Story not found',
      } satisfies ApiResponse<null>);
    }

    // H1: Verify ownership — any authenticated user could previously export
    // any other user's complete story content by guessing a CUID/UUID.
    const authReq = req as AuthenticatedRequest;
    if (!verifyStoryOwnership(story.userId!, authReq, res)) return;

    const flags: ExportFlags = {
      voiceover: includeVoiceover,
      prompts: includePrompts,
      metadata: includeMetadata,
      content,
    };

    const safeName = story.title.replace(/[^a-z0-9]/gi, '_') || 'story';
    let body: string;
    let filename: string;
    let contentType: string;

    switch (format as ExportFormat) {
      case 'json':
        body = JSON.stringify(buildJsonExport(story, flags), null, 2);
        filename = `${safeName}_export.json`;
        contentType = 'application/json';
        break;
      case 'csv':
        body = buildCsvExport(story, flags);
        filename = `${safeName}_export.csv`;
        contentType = 'text/csv';
        break;
      case 'ssml':
        body = storyToSSML(story);
        filename = `${safeName}.ssml.xml`;
        contentType = 'application/ssml+xml';
        break;
      case 'srt':
        body = storyToSRT(story);
        filename = `${safeName}.srt`;
        contentType = 'application/x-subrip';
        break;
      case 'vtt':
        body = storyToVTT(story);
        filename = `${safeName}.vtt`;
        contentType = 'text/vtt';
        break;
      case 'txt':
      default:
        body = buildTxtExport(story, flags);
        filename = `${safeName}_export.txt`;
        contentType = 'text/plain';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  })
);

// ---------- Builders ----------

interface JsonExport {
  metadata?: {
    title: string;
    genre: string;
    theme?: string;
    totalEpisodes: number;
    totalScenes: number;
    estimatedDuration: number;
  };
  youtubeSeo?: Story['youtubeSeo'];
  episodes?: Array<{
    number: number;
    title: string;
    hook?: string;
    synopsis?: string;
    cliffhanger?: string;
    voiceoverScript?: string;
    musicSuggestions?: string[];
    soundDesign?: string[];
    scenes: Array<{
      number: number;
      narration?: string;
      duration?: number;
      emotion?: string;
      imagePrompt?: string;
      videoPrompt?: string;
      camera?: { type: string; movement: string; angle: string; lens: string };
      transition?: string;
      emotionalIntensity?: number;
    }>;
  }>;
}

function buildJsonExport(story: Story, flags: ExportFlags): JsonExport {
  const out: JsonExport = {};

  if (flags.metadata) {
    out.metadata = {
      title: story.title,
      genre: story.genre,
      ...(story.theme !== undefined ? { theme: story.theme } : {}),
      totalEpisodes: story.episodes.length,
      totalScenes: story.episodes.reduce((s, e) => s + e.scenes.length, 0),
      estimatedDuration: story.metadata?.estimatedDuration ?? 0,
    };
    if (story.youtubeSeo) out.youtubeSeo = story.youtubeSeo;
  }

  out.episodes = story.episodes.map((ep) => ({
    number: ep.number,
    title: ep.title,
    ...((flags.content === 'full' || flags.content === 'voiceover-only') ? {
      ...(ep.hook !== undefined ? { hook: ep.hook } : {}),
      ...(ep.synopsis !== undefined ? { synopsis: ep.synopsis } : {}),
      ...(ep.cliffhanger !== undefined ? { cliffhanger: ep.cliffhanger } : {}),
      ...(flags.voiceover ? { voiceoverScript: ep.voiceoverText } : {}),
    } : {}),
    ...(flags.content === 'full' ? {
      musicSuggestions: ep.musicSuggestions,
      soundDesign: ep.soundDesign,
    } : {}),
    scenes: ep.scenes.map((sc) => ({
      number: sc.number,
      ...((flags.voiceover && (flags.content === 'full' || flags.content === 'voiceover-only')) ? {
        narration: sc.narration.text,
        emotion: sc.narration.emotion,
      } : {}),
      ...(flags.content === 'full' ? {
        duration: sc.duration,
        camera: sc.cameraDirection,
        transition: sc.transitionType,
        emotionalIntensity: sc.emotionalIntensity,
      } : {}),
      ...(flags.prompts && (flags.content === 'full' || flags.content === 'prompts-only') ? {
        imagePrompt: sc.imagePrompt.content,
        videoPrompt: sc.videoPrompt.content,
      } : {}),
    })),
  }));

  return out;
}

function buildCsvExport(story: Story, flags: ExportFlags): string {
  const voiceoverEnabled = flags.voiceover && flags.content !== 'prompts-only';
  const promptsEnabled =
    flags.prompts && flags.content !== 'voiceover-only' && flags.content !== 'scenes-only';

  const rows: string[] = [
    'Episode,Scene,Narration,Emotion,ImagePrompt,VideoPrompt,Duration,CameraType,CameraMovement',
  ];
  for (const ep of story.episodes) {
    for (const sc of ep.scenes) {
      const narration = voiceoverEnabled ? csvEscape(sc.narration.text) : '""';
      const emotion = csvEscape(sc.narration.emotion);
      const img = promptsEnabled ? csvEscape(sc.imagePrompt.content) : '""';
      const vid = promptsEnabled ? csvEscape(sc.videoPrompt.content) : '""';
      rows.push(
        [
          ep.number,
          sc.number,
          narration,
          emotion,
          img,
          vid,
          sc.duration,
          csvEscape(sc.cameraDirection.type),
          csvEscape(sc.cameraDirection.movement),
        ].join(',')
      );
    }
  }
  return rows.join('\n');
}

// SEC-006: XML/HTML entity encoding for CSV cells.
// NOTE: `"` is deliberately NOT included here — CSV RFC 4180 handles it via
// `""` double-quote escaping (applied AFTER this in csvEscape). If `"` were
// encoded to `&quot;` here, the subsequent `replace(/"/g, '""')` would be a
// no-op, producing literal `&quot;` text in CSV cells instead of `""`.
const DANGEROUS_XML_CHARS = /[<>&']/g;
const XML_ENTITY_MAP: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&#39;',
};

function csvEscape(value: string): string {
  if (!value) return '""';
  // Prevent CSV formula injection — prefix values that start with formula-trigger
  // characters with a tab so spreadsheet parsers treat them as text.
  let escaped = value;
  if (/^[+=\-@\t\r]/.test(escaped)) {
    escaped = `\t${escaped}`;
  }
  // Escape XML/HTML entities to prevent XSS in HTML-aware CSV renderers
  escaped = escaped.replace(DANGEROUS_XML_CHARS, (ch) => XML_ENTITY_MAP[ch]!);
  escaped = escaped.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildTxtExport(story: Story, flags: ExportFlags): string {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(story.title);
  lines.push('='.repeat(60));
  lines.push(`Genre: ${story.genre}`);
  if (story.theme) lines.push(`Theme: ${story.theme}`);
  lines.push('');

  for (const ep of story.episodes as Episode[]) {
    lines.push(`\n--- EPISODE ${ep.number}: ${ep.title} ---`);

    if (flags.content === 'voiceover-only') {
      // Pure TTS-ready prose, no labels.
      const tts = ep.voiceoverText || '';
      if (tts) lines.push(tts);
      lines.push('');
      continue;
    }

    if (flags.content === 'full') {
      lines.push(`HOOK: ${ep.hook}`);
      lines.push(`SYNOPSIS: ${ep.synopsis}`);
      lines.push(`CLIFFHANGER: ${ep.cliffhanger}`);
      if (ep.musicSuggestions?.length) lines.push(`MUSIC: ${ep.musicSuggestions.join(', ')}`);
      if (ep.soundDesign?.length) lines.push(`SOUND DESIGN: ${ep.soundDesign.join(', ')}`);
    }
    lines.push('');
    lines.push('SCENES:');
    for (const sc of ep.scenes as Scene[]) {
      lines.push(`  [Scene ${sc.number}] (${sc.duration}s, ${sc.narration.emotion})`);
      if (flags.voiceover && sc.narration?.text) lines.push(`  Narration: ${sc.narration.text}`);
      if (flags.prompts) {
        if (sc.imagePrompt?.content)
          lines.push(`  Image: ${sc.imagePrompt.content.substring(0, 200)}...`);
        if (sc.videoPrompt?.content)
          lines.push(`  Video: ${sc.videoPrompt.content.substring(0, 200)}...`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export const exportRouter = router;
