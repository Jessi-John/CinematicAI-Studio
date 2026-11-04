/**
 * Fix #26: OpenAPI 3.1 spec for the CinematicAI Studio API.
 *
 * The Zod schemas in auth.ts and admin.ts (validated with #47) are the source
 * of truth for request validation. This module defines the OpenAPI 3.1 spec that
 * documents those contracts.
 *
 * Exposed at GET /api/docs (JSON) and GET /api/docs/ui (Swagger UI via Redoc).
 * The spec can be fed into OpenAPI-compatible tooling (Postman, Insomnia,
 * client generators) to catch client/server contract drift (#23).
 */

import { Router } from 'express';
import { verifyAdminAuth } from '../middleware/admin.js';
import { asyncHandler, asyncMiddleware } from '../middleware/error.js';

const router = Router();

// SEC-OPENAPI: The OpenAPI spec exposes endpoint paths, auth schemes, and
// operational details that should not be public. Restrict /api/docs and
// /api/docs/ui to admin users (JWT cookie with role='admin' or
// ADMIN_API_KEY bearer token).

function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'http://localhost:34567';
}

// ---------- OpenAPI 3.1 document ----------

const openApiDoc = {
  openapi: '3.1.0',
  info: {
    title: 'CinematicAI Studio API',
    version: '1.0.0',
    description: [
      'CinematicAI Studio REST API for AI-generated anime Shorts.',
      '',
      '## Authentication',
      'Most endpoints require a JWT cookie (`access_token`) obtained via POST /api/auth/login.',
      'Mutating requests additionally require the X-CSRF-Token header.',
      '',
      '## Rate Limiting',
      '| Group | Limit |',
      '|---|---|',
      '| General | 100/min |',
      '| AI | 10/min |',
      '| Admin | 60/min |',
      '| Stories | 60/min |',
      '',
      '## Errors',
      'All errors follow `{ success: false, error: "..." }`.',
    ].join('\n'),
  },
  servers: [
    { url: getApiBaseUrl(), description: 'API server' },
  ],
  paths: {

    // ─── Auth ────────────────────────────────────────────────────────────────

    '/api/auth/register': {
      post: {
        tags: ['auth'],
        summary: 'Register a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    username: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 30,
                      pattern: '^[a-zA-Z0-9_]+$',
                      description: '3-30 chars, letters/numbers/underscores only',
                    },
                    password: { type: 'string', minLength: 8, maxLength: 128, description: 'Must score at least 3/6 on strength (length, uppercase, lowercase, numbers, special characters)' },
                    inviteCode: { type: 'string', description: 'Required when registration is disabled' },
                  },
                  required: ['username', 'password'],
                  additionalProperties: false,
                },
            },
          },
        },
        responses: {
          '201': {
            description: 'User created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: { userId: { type: 'string' } },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '409': { description: 'Username already taken', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    '/api/auth/login': {
      post: {
        tags: ['auth'],
        summary: 'Login — returns JWT cookie',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string', minLength: 3, maxLength: 30 },
                  password: { type: 'string', minLength: 8, maxLength: 128 },
                },
                required: ['username', 'password'],
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': { description: 'Login OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '401': { description: 'Invalid credentials', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    '/api/auth/logout': {
      post: {
        tags: ['auth'],
        summary: 'Logout — clears JWT cookie',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Logged out', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } } } },
          '401': { description: 'Not authenticated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    '/api/auth/me': {
      get: {
        tags: ['auth'],
        summary: 'Get current authenticated user',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'User object',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        username: { type: 'string' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Not authenticated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    '/api/auth/refresh': {
      post: {
        tags: ['auth'],
        summary: 'Refresh JWT expiry',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': { description: 'Token refreshed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } } } },
          '401': { description: 'Not authenticated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    // ─── Admin ────────────────────────────────────────────────────────────────

    '/api/admin/queue': {
      get: {
        tags: ['admin'],
        summary: 'Queue depth, active jobs, and recent DLQ failures',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Queue stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        queueDepth: { type: 'integer' },
                        activeJobs: { type: 'integer' },
                        completedToday: { type: 'integer' },
                        dlqDepth: { type: 'integer' },
                        recentFailures: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              jobId: { type: 'string' },
                              genre: { type: 'array', items: { type: 'string' } },
                              failedAt: { type: 'number' },
                              failedReason: { type: 'string' },
                              attemptsMade: { type: 'integer' },
                            },
                          },
                        },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/queue/{jobId}/restart': {
      post: {
        tags: ['admin'],
        summary: 'Restart a failed DLQ job',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'jobId',
            in: 'path',
            required: true,
            description: 'UUID v4 or BullMQ internal id (c + 20-28 alphanumeric)',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Job restarted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        restarted: { type: 'boolean' },
                        originalJobId: { type: 'string' },
                        newJobId: { type: 'string' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Invalid job ID format', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '404': { description: 'DLQ entry not found' },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/settings/timing': {
      get: {
        tags: ['admin'],
        summary: 'Get timing constants',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Current timing settings',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        episodesPerStory: { type: 'integer' },
                        scenesPerEpisode: { type: 'integer' },
                        targetWordsPerScene: { type: 'integer' },
                        targetEpisodeWordsMin: { type: 'integer' },
                        targetEpisodeWordsMax: { type: 'integer' },
                        sceneDurationMinSeconds: { type: 'integer' },
                        sceneDurationMaxSeconds: { type: 'integer' },
                        speakingWpm: { type: 'integer' },
                        targetEpisodeSeconds: { type: 'integer' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
      patch: {
        tags: ['admin'],
        summary: 'Update timing constants',
        description: 'Cross-field constraints: targetEpisodeWordsMin ≤ targetEpisodeWordsMax; sceneDurationMinSeconds ≤ sceneDurationMaxSeconds.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  episodesPerStory: { type: 'integer', minimum: 1, maximum: 20 },
                  scenesPerEpisode: { type: 'integer', minimum: 1, maximum: 20 },
                  targetWordsPerScene: { type: 'integer', minimum: 5, maximum: 100 },
                  targetEpisodeWordsMin: { type: 'integer', minimum: 50, maximum: 500 },
                  targetEpisodeWordsMax: { type: 'integer', minimum: 50, maximum: 500 },
                  sceneDurationMinSeconds: { type: 'integer', minimum: 1, maximum: 60 },
                  sceneDurationMaxSeconds: { type: 'integer', minimum: 1, maximum: 60 },
                  speakingWpm: { type: 'integer', minimum: 50, maximum: 300 },
                  targetEpisodeSeconds: { type: 'integer', minimum: 10, maximum: 300 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        updated: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              key: { type: 'string' },
                              value: { type: 'number' },
                            },
                          },
                        },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Validation error (includes Zod constraint details)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/settings/pipeline': {
      get: {
        tags: ['admin'],
        summary: 'Get pipeline quality gate settings',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Pipeline settings',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        qualityFloor: { type: 'integer' },
                        gradeFloor: { type: 'string' },
                        humanizationLimit: { type: 'integer' },
                        humanizationBudget: { type: 'integer' },
                        humanizationRetries: { type: 'integer' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/settings/pipeline/{key}': {
      put: {
        tags: ['admin'],
        summary: 'Update a pipeline quality gate setting',
        description: 'Allowed keys: quality_floor, grade_floor, humanization_score_limit, humanization_story_budget, humanization_story_quality_retries.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'key',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: [
                'quality_floor',
                'grade_floor',
                'humanization_score_limit',
                'humanization_story_budget',
                'humanization_story_quality_retries',
              ],
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  value: {
                    oneOf: [{ type: 'string' }, { type: 'number' }],
                    description: 'Stored as string; numbers are accepted and coerced',
                  },
                },
                required: ['value'],
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: { key: { type: 'string' }, value: { type: 'string' } },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/dlq': {
      get: {
        tags: ['admin'],
        summary: 'List all DLQ entries (main pipeline + background)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'DLQ entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        entries: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              jobId: { type: 'string' },
                              genre: { type: 'array', items: { type: 'string' } },
                              failedAt: { type: 'number' },
                              failedReason: { type: 'string' },
                              attemptsMade: { type: 'integer' },
                              data: { type: 'object' },
                            },
                          },
                        },
                        backgroundEntries: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              source: { type: 'string', const: 'background' },
                              jobId: { type: 'string' },
                              failedAt: { type: 'string' },
                              failedReason: { type: 'string' },
                              data: { type: 'object' },
                            },
                          },
                        },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/dlq/{jobId}/requeue': {
      post: {
        tags: ['admin'],
        summary: 'Requeue a DLQ job back to the pipeline',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Requeued',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'object', properties: { jobId: { type: 'string' } } },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Invalid job ID format', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '404': { description: 'Job not found in DLQ' },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/dlq/{jobId}': {
      delete: {
        tags: ['admin'],
        summary: 'Delete a DLQ entry',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'object', properties: { jobId: { type: 'string' } } },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '400': { description: 'Invalid job ID format', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
          '404': { description: 'Job not found in DLQ' },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    '/api/admin/stats': {
      get: {
        tags: ['admin'],
        summary: 'System-wide database statistics',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        totalStories: { type: 'integer' },
                        totalEpisodes: { type: 'integer' },
                        totalScenes: { type: 'integer' },
                        totalCharacters: { type: 'integer' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
          '401': { description: 'Missing admin authorization' },
          '403': { description: 'Invalid admin API key' },
        },
      },
    },

    // ─── Public ───────────────────────────────────────────────────────────────

    '/api/health': {
      get: {
        tags: ['public'],
        summary: 'Health check — DB + Redis ping',
        responses: {
          '200': { description: 'Healthy', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } } } },
          '503': { description: 'Unhealthy', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } }, required: ['success', 'error'] } } } },
        },
      },
    },

    '/api/public-config': {
      get: {
        tags: ['public'],
        summary: 'Public client configuration (no auth)',
        responses: {
          '200': {
            description: 'Client config',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        GENRES: { type: 'array', items: { type: 'string' } },
                        DEFAULT_GENRE: { type: 'string' },
                        MAX_SEED_LENGTH: { type: 'integer' },
                        registrationDisabled: { type: 'boolean' },
                      },
                    },
                  },
                  required: ['success', 'data'],
                },
              },
            },
          },
        },
      },
    },

    // ─── Stories ───────────────────────────────────────────────────────────────

    '/api/stories': {
      get: {
        tags: ['stories'],
        summary: 'List stories with pagination, search, and genre filter',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, description: 'Page size (1-100)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque cursor for the active sortBy (base64url for title; ISO 8601 legacy for newest/oldest)' },
          { name: 'search', in: 'query', schema: { type: 'string', maxLength: 200 }, description: 'Full-text search across titles and themes' },
          { name: 'genre', in: 'query', schema: { type: 'string', maxLength: 50 }, description: 'Filter by genre' },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest', 'title'], default: 'newest' }, description: 'Server-side sort order' },
        ],
        responses: {
          '200': {
            description: 'Paginated story list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        stories: { type: 'array', items: { type: 'object' } },
                        // PERF-LIST-TOTAL: null on cursor pages (page 2+), where
                        // the COUNT query is skipped. First page always returns a number.
                        total: { type: 'integer', nullable: true },
                        hasMore: { type: 'boolean' },
                        nextCursor: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    '/api/stories/{id}': {
      get: {
        tags: ['stories'],
        summary: 'Get a single story with full episode/scene hierarchy',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Story UUID or CUID' },
        ],
        responses: {
          '200': { description: 'Full story object with episodes, scenes, characters' },
          '404': { description: 'Story not found' },
        },
      },
      patch: {
        tags: ['stories'],
        summary: 'Update story metadata (title, status, theme)',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string', maxLength: 200 },
                  status: { type: 'string', enum: ['draft', 'generating', 'complete', 'failed'] },
                  theme: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated story' },
          '400': { description: 'Invalid request body' },
          '404': { description: 'Story not found' },
          '409': { description: 'Invalid status transition' },
        },
      },
      delete: {
        tags: ['stories'],
        summary: 'Delete a story and all associated data',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Story deleted' },
          '404': { description: 'Story not found' },
        },
      },
    },

    // ─── Story Generation ───────────────────────────────────────────────────────

    '/api/stories/generate': {
      post: {
        tags: ['generation'],
        summary: 'Enqueue a new story generation job',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  genre: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1, description: 'Exactly one genre' },
                  seed: { type: 'string', maxLength: 500, description: 'Optional story seed/idea' },
                  forceNew: { type: 'boolean', description: 'Skip duplicate detection' },
                  webhookUrl: { type: 'string', format: 'uri', description: 'Optional webhook URL for completion callback' },
                },
                required: ['genre'],
                additionalProperties: false,
              },
            },
          },
        },
        headers: {
          'X-Idempotency-Key': { schema: { type: 'string', format: 'uuid' }, description: 'Optional idempotency key (UUID v4)' },
        },
        responses: {
          '202': { description: 'Job queued — returns jobId, sseUrl, and sseAuth' },
          '400': { description: 'Validation error (invalid genre, seed contains copyright terms)' },
          '409': { description: 'Duplicate story concept detected (with similarity details)' },
        },
      },
    },

    '/api/stories/generate/{jobId}/events': {
      get: {
        tags: ['generation'],
        summary: 'SSE event stream for generation progress updates',
        description: 'Server-sent events (text/event-stream). Authenticated via HMAC query params (auth + t) from the generate endpoint response.',
        parameters: [
          { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'auth', in: 'query', required: true, schema: { type: 'string' }, description: 'HMAC signature' },
          { name: 't', in: 'query', required: true, schema: { type: 'integer' }, description: 'Timestamp for HMAC validation' },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' }, description: 'Last received event ID for resume support' },
        ],
        responses: {
          '200': { description: 'SSE event stream (text/event-stream)' },
          '401': { description: 'Invalid or expired auth' },
        },
      },
    },

    '/api/stories/generate/{jobId}/status': {
      get: {
        tags: ['generation'],
        summary: 'Poll generation job status',
        description: 'Accepts either JWT cookie or HMAC SSE auth query params.',
        parameters: [
          { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'auth', in: 'query', schema: { type: 'string' }, description: 'Optional HMAC auth (alternative to JWT)' },
          { name: 't', in: 'query', schema: { type: 'integer' }, description: 'HMAC timestamp' },
        ],
        responses: {
          '200': { description: 'Job status (state, progress, data)' },
          '401': { description: 'Authentication required' },
        },
      },
    },

    '/api/stories/generate/{storyId}/generation-status': {
      get: {
        tags: ['generation'],
        summary: 'Get full generation status for a persisted story',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'storyId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Generation status with logs and story title' },
          '404': { description: 'Story not found' },
        },
      },
    },

    '/api/stories/generate/{jobId}/full-state': {
      get: {
        tags: ['generation'],
        summary: 'Get full job state including story data if complete',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Job state, progress, and story data if completed' },
          '404': { description: 'Job not found' },
        },
      },
    },

    // ─── Episode/Scene Regeneration ──────────────────────────────────────────────

    '/api/stories/generate/{storyId}/regenerate': {
      post: {
        tags: ['generation'],
        summary: 'Regenerate an entire story atomically (replace-in-place)',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'storyId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Story regenerated and atomically replaced' },
          '404': { description: 'Story not found' },
        },
      },
    },

    '/api/stories/generate/{storyId}/episodes/{episodeNumber}': {
      patch: {
        tags: ['generation'],
        summary: 'Regenerate a single episode',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'storyId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'episodeNumber', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 10 } },
        ],
        responses: {
          '200': { description: 'Episode regenerated' },
          '400': { description: 'Invalid episode number' },
          '404': { description: 'Story not found' },
        },
      },
    },

    '/api/stories/generate/{storyId}/episodes/{episodeNumber}/scenes/{sceneNumber}': {
      patch: {
        tags: ['generation'],
        summary: 'Regenerate a single scene',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'storyId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'episodeNumber', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 10 } },
          { name: 'sceneNumber', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 5 } },
        ],
        responses: {
          '200': { description: 'Scene regenerated' },
          '400': { description: 'Invalid episode or scene number' },
          '404': { description: 'Story not found' },
        },
      },
    },

    // ─── Similarity ───────────────────────────────────────────────────────────────

    '/api/stories/check-similarity': {
      get: {
        tags: ['similarity'],
        summary: 'Check if a story concept is too similar to existing stories',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        // M11: The implementation (similarity.ts) is a GET that reads query
        // params, not a JSON body. The previous doc declared a requestBody,
        // which is both invalid for GET and contrary to the actual handler.
        parameters: [
          {
            name: 'genre',
            in: 'query',
            required: true,
            schema: { type: 'string', maxLength: 50 },
            description: 'Genre to compare against',
          },
          {
            name: 'seed',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 500 },
            description: 'Story seed/idea to compare',
          },
        ],
        responses: {
          '200': {
            description: 'Similarity scores with matching stories',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        isSimilar: { type: 'boolean' },
                        score: { type: 'number' },
                        similarStories: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              title: { type: 'string' },
                              score: { type: 'number' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ─── Export ───────────────────────────────────────────────────────────────────

    '/api/stories/{id}/export': {
      post: {
        tags: ['export'],
        summary: 'Export a story in various formats',
        security: [{ cookieAuth: [] }, { csrfAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  format: { type: 'string', enum: ['json', 'csv', 'txt', 'ssml', 'srt', 'vtt'], default: 'json' },
                  content: { type: 'string', enum: ['full', 'prompts-only', 'voiceover-only', 'scenes-only'], default: 'full' },
                  includeVoiceover: { type: 'boolean', default: true },
                  includePrompts: { type: 'boolean', default: true },
                  includeMetadata: { type: 'boolean', default: true },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': { description: 'File download with appropriate Content-Type and Content-Disposition' },
          '400': { description: 'Invalid export configuration' },
          '404': { description: 'Story not found' },
        },
      },
    },

    // ─── Alerts ──────────────────────────────────────────────────────────────

    '/api/alerts/alerts': {
      post: {
        tags: ['alerts'],
        summary: 'Receive Prometheus/Alertmanager webhook alerts',
        description: 'Authenticated via ALERT_RECEIVER_TOKEN bearer token. Logs every firing/resolved alert and optionally forwards to ALERT_WEBHOOK_URL.',
        security: [{ alertBearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['firing', 'resolved'] },
                  alerts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        status: { type: 'string', enum: ['firing', 'resolved'] },
                        labels: { type: 'object', additionalProperties: { type: 'string' } },
                        annotations: { type: 'object', additionalProperties: { type: 'string' } },
                        startsAt: { type: 'string', format: 'date-time' },
                        endsAt: { type: 'string', format: 'date-time' },
                      },
                      required: ['status', 'labels', 'annotations', 'startsAt'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Alerts accepted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    received: { type: 'integer' },
                  },
                  required: ['success', 'received'],
                },
              },
            },
          },
          '401': { description: 'Missing or invalid alert receiver token' },
          '503': { description: 'Alert receiver not configured' },
        },
      },
    },

  },

  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'access_token',
        description: 'JWT cookie set by POST /api/auth/login',
      },
      bearerAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'ADMIN_API_KEY for admin routes, JWT for user routes',
      },
      alertBearerAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'ALERT_RECEIVER_TOKEN bearer token for Alertmanager webhooks',
      },
    },
  },

  tags: [
    { name: 'auth', description: 'Authentication: register, login, logout, JWT refresh, current user' },
    { name: 'admin', description: 'Admin-only: queue monitoring, DLQ management, timing/pipeline settings, stats' },
    { name: 'stories', description: 'Story CRUD: list, get, update, and delete stories' },
    { name: 'generation', description: 'Story generation: enqueue, regenerate episodes/scenes, SSE events, status' },
    { name: 'similarity', description: 'Duplicate detection: check story similarity before generation' },
    { name: 'export', description: 'Story export: JSON, CSV, TXT, SSML, SRT, VTT' },
    { name: 'public', description: 'Public endpoints: health check, client config' },
    { name: 'alerts', description: 'Alert receiver: Prometheus/Alertmanager webhook' },
  ],
};

// GET /api/docs — OpenAPI 3.1 JSON spec
router.get('/', asyncMiddleware(verifyAdminAuth), asyncHandler(async (_req, res) => {
  res.json(openApiDoc);
}));

// GET /api/docs/ui — Swagger UI via Redoc. The Redoc bundle is loaded from
// cdn.jsdelivr.net; the accompanying CSP relaxation that permits that CDN (and
// the inline init script) is scoped to /api/docs only — see CRIT-14 in
// server.ts. This is a deliberate, admin-only exception, not a global CSP weaken.
router.get('/ui', asyncMiddleware(verifyAdminAuth), asyncHandler(async (_req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CinematicAI Studio API</title>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"
    integrity="sha384-0GrsyTQc9Oqd8h+b2dbc4XdR2T/DYpy0tLNNstyx+LBMUyiBbcWPbEs9aRmUcaxD"
    crossorigin="anonymous"></script>
  <script>
    var specUrl = location.pathname.endsWith('/ui') ? location.pathname.slice(0, -3) : location.pathname;
    Redoc.init(specUrl, {}, document.getElementById('redoc-container'));
  </script>
</body>
</html>`);
}));

export { router as openapiRouter };
