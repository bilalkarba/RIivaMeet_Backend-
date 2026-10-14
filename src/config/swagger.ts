import path from 'node:path';
import { fileURLToPath } from 'node:url';

import swaggerJSDoc from 'swagger-jsdoc';

import { SERVICE_NAME, SERVICE_VERSION } from './constants.js';
import { env } from './env.js';

/**
 * OpenAPI 3.0 document.
 *
 * Endpoint documentation lives next to the route definitions as `@openapi` JSDoc
 * blocks; the shared components (schemas, security scheme, reusable error
 * responses) are declared below.
 *
 * The annotation glob is resolved relative to *this* file so it works both when
 * running from source (tsx -> `src/routes/*.ts`) and from the compiled output
 * (`node dist/server.js` -> `dist/routes/*.js`).
 */
const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * swagger-jsdoc resolves annotations through `glob`, which treats "\\" as an escape
 * character - so Windows paths must be converted to forward slashes or every
 * annotation glob silently matches nothing (Swagger UI would show zero endpoints).
 */
const toGlobPath = (target: string): string => target.split(path.sep).join('/');
const routesGlob = `${toGlobPath(path.join(currentDir, '..', 'routes'))}/*.{ts,js}`;
const configGlob = `${toGlobPath(currentDir)}/swagger.{ts,js}`;

export const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Coachini API',
    version: SERVICE_VERSION,
    description: [
      `Sports coach discovery and booking platform (${SERVICE_NAME}).`,
      '',
      '**Authentication** - send the JWT access token returned by `/api/v1/auth/register`',
      'or `/api/v1/auth/login` as `Authorization: Bearer <token>`.',
      '',
      '**Response envelope** - successful responses are `{ "data": ... }` (plus `meta` for',
      'paginated lists); failures are `{ "error": { "code", "message", "details?" }, "requestId" }`.',
      '',
      '**Money** - prices are serialized as 2-decimal strings (`"45.00"`) so clients never',
      'lose precision to floating point.',
      '',
      '**Dates** - all timestamps are ISO 8601 UTC strings.',
    ].join('\n'),
  },
  servers: [
    { url: '/', description: 'Current host' },
    { url: `http://localhost:${env.PORT}`, description: 'Local development' },
  ],
  tags: [
    { name: 'Auth', description: 'Registration, login and the current user' },
    { name: 'Profile', description: 'Self-service profiles and athlete disciplines' },
    { name: 'Matching', description: 'Compatible-profile suggestions' },
    { name: 'Storage', description: 'Object storage status and presigned uploads' },
    { name: 'Sports', description: 'Sport catalogue' },
    { name: 'Coaches', description: 'Coach profiles and search' },
    { name: 'Availability', description: 'Coach availability windows' },
    { name: 'Bookings', description: 'Booking requests and lifecycle' },
    { name: 'Reviews', description: 'Reviews for completed bookings' },
    { name: 'Chat', description: 'Private conversations and messages' },
    { name: 'Calls', description: 'Audio/video call signalling (WebRTC over Socket.IO)' },
    { name: 'Safety', description: 'Blocking and reporting' },
    { name: 'Admin', description: 'Admin back-office (ADMIN only)' },
    { name: 'Health', description: 'Service health' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR',
                  'UNAUTHORIZED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'CONFLICT',
                  'RATE_LIMITED',
                  'PAYLOAD_TOO_LARGE',
                  'SERVICE_UNAVAILABLE',
                  'INTERNAL_ERROR',
                ],
              },
              message: { type: 'string' },
              details: { nullable: true },
            },
          },
          requestId: { type: 'string' },
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 20 },
          total: { type: 'integer', example: 42 },
          totalPages: { type: 'integer', example: 3 },
          hasNextPage: { type: 'boolean', example: true },
          hasPreviousPage: { type: 'boolean', example: false },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          phone: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['CLIENT', 'COACH', 'ADMIN'] },
          hasCoachProfile: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              user: { $ref: '#/components/schemas/User' },
              accessToken: { type: 'string' },
              tokenType: { type: 'string', example: 'Bearer' },
              expiresIn: { type: 'string', example: '1h' },
            },
          },
        },
      },
      Sport: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Boxing' },
          slug: { type: 'string', example: 'boxing' },
          coachCount: { type: 'integer', example: 4 },
        },
      },
      CoachProfileInput: {
        type: 'object',
        properties: {
          bio: { type: 'string', minLength: 20, maxLength: 2000 },
          certifications: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', minLength: 2, maxLength: 120 },
            example: ['UEFA B Licence', 'First Aid Certificate'],
          },
          hourlyPrice: { type: 'number', minimum: 0, example: 45.5 },
          experienceLevel: {
            type: 'string',
            enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL'],
          },
          city: { type: 'string', example: 'Berlin' },
          neighborhood: { type: 'string', example: 'Mitte' },
          address: { type: 'string', nullable: true, example: 'Torstrasse 1' },
          latitude: { type: 'number', nullable: true, example: 52.52 },
          longitude: { type: 'number', nullable: true, example: 13.405 },
          isPublished: { type: 'boolean', example: true },
        },
      },
      Coach: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'CoachProfile id' },
          userId: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Anna Schmidt' },
          bio: { type: 'string' },
          certifications: { type: 'array', items: { type: 'string' }, example: ['UEFA B Licence'] },
          hourlyPrice: { type: 'string', example: '45.00' },
          experienceLevel: {
            type: 'string',
            enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL'],
          },
          city: { type: 'string', example: 'Berlin' },
          neighborhood: { type: 'string', example: 'Mitte' },
          address: { type: 'string', nullable: true },
          latitude: { type: 'number', nullable: true },
          longitude: { type: 'number', nullable: true },
          isPublished: { type: 'boolean' },
          sports: { type: 'array', items: { $ref: '#/components/schemas/Sport' } },
          averageRating: {
            type: 'number',
            nullable: true,
            example: 4.5,
            description: 'Derived from the reviews table (never stored); null when there are no reviews',
          },
          reviewCount: { type: 'integer', example: 12 },
          distanceKm: {
            type: 'number',
            nullable: true,
            description: 'Only present when searching with latitude/longitude',
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CoachDetail: {
        allOf: [
          { $ref: '#/components/schemas/Coach' },
          {
            type: 'object',
            properties: {
              coachName: { type: 'string' },
              availability: { type: 'array', items: { $ref: '#/components/schemas/Availability' } },
              totalBookings: { type: 'integer', description: 'Number of completed bookings' },
            },
          },
        ],
      },
      Availability: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          startAt: { type: 'string', format: 'date-time' },
          endAt: { type: 'string', format: 'date-time' },
          isAvailable: { type: 'boolean' },
        },
      },
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED'],
          },
          startAt: { type: 'string', format: 'date-time' },
          endAt: { type: 'string', format: 'date-time' },
          durationMinutes: { type: 'integer', example: 60 },
          priceAtBooking: { type: 'string', example: '45.00' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          client: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
            },
          },
          coach: {
            type: 'object',
            properties: {
              coachProfileId: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              city: { type: 'string' },
              neighborhood: { type: 'string' },
              hourlyPrice: { type: 'string' },
            },
          },
          review: {
            nullable: true,
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              rating: { type: 'integer', minimum: 1, maximum: 5 },
              comment: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      Review: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          bookingId: { type: 'string', format: 'uuid' },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          client: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
            },
          },
        },
      },
      ProfileSport: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Boxing' },
          slug: { type: 'string', example: 'boxing' },
          level: { type: 'string', nullable: true, enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL'] },
        },
      },
      ProfileInput: {
        type: 'object',
        properties: {
          displayName: { type: 'string', nullable: true, maxLength: 60 },
          avatarUrl: { type: 'string', nullable: true, format: 'uri' },
          bio: { type: 'string', nullable: true, maxLength: 2000 },
          city: { type: 'string', nullable: true },
          country: { type: 'string', nullable: true },
          level: { type: 'string', nullable: true, enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL'] },
        },
      },
      SelfProfile: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          avatarUrl: { type: 'string', nullable: true },
          bio: { type: 'string', nullable: true },
          city: { type: 'string', nullable: true },
          country: { type: 'string', nullable: true },
          level: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['CLIENT', 'COACH', 'ADMIN'] },
          phone: { type: 'string', nullable: true },
          sports: { type: 'array', items: { $ref: '#/components/schemas/ProfileSport' } },
          hasCoachProfile: { type: 'boolean' },
          coachProfileId: { type: 'string', nullable: true, format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      PublicProfile: {
        type: 'object',
        description: 'Privacy-safe projection (never contains email, phone or moderation data)',
        properties: {
          id: { type: 'string', format: 'uuid' },
          displayName: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          bio: { type: 'string', nullable: true },
          city: { type: 'string', nullable: true },
          country: { type: 'string', nullable: true },
          level: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['CLIENT', 'COACH', 'ADMIN'] },
          sports: { type: 'array', items: { $ref: '#/components/schemas/ProfileSport' } },
          isCoach: { type: 'boolean' },
          coachProfileId: { type: 'string', nullable: true, format: 'uuid' },
          memberSince: { type: 'string', format: 'date-time' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          conversationId: { type: 'string', format: 'uuid' },
          senderId: { type: 'string', format: 'uuid' },
          body: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Conversation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          participant: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              displayName: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
            },
          },
          lastMessage: { allOf: [{ $ref: '#/components/schemas/Message' }], nullable: true },
          unreadCount: { type: 'integer', example: 0 },
          lastMessageAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Call: {
        type: 'object',
        description:
          'One audio/video call. `direction` is resolved for the authenticated user. Media, SDP and ICE candidates are never stored or returned.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          conversationId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['AUDIO', 'VIDEO'] },
          status: {
            type: 'string',
            enum: ['RINGING', 'ACCEPTED', 'REJECTED', 'MISSED', 'CANCELLED', 'ENDED'],
          },
          direction: { type: 'string', enum: ['OUTGOING', 'INCOMING'] },
          caller: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              displayName: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
            },
          },
          callee: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              displayName: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
            },
          },
          startedAt: { type: 'string', format: 'date-time' },
          answeredAt: { type: 'string', format: 'date-time', nullable: true },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
          endedById: { type: 'string', format: 'uuid', nullable: true },
        },
      },
      CallConfig: {
        type: 'object',
        properties: {
          iceServers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                urls: { type: 'array', items: { type: 'string' } },
                username: { type: 'string' },
                credential: { type: 'string' },
              },
            },
          },
          ringTimeoutMs: { type: 'integer', example: 45000 },
        },
      },
      BlockedUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          displayName: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          blockedAt: { type: 'string', format: 'date-time' },
        },
      },
      Report: {
        type: 'object',
        description: 'Reporter projection: no reviewer identity or internal fields',
        properties: {
          id: { type: 'string', format: 'uuid' },
          targetType: { type: 'string', enum: ['USER', 'POST', 'MESSAGE'] },
          targetId: { type: 'string', format: 'uuid' },
          targetUserId: { type: 'string', format: 'uuid', nullable: true },
          reason: { type: 'string', enum: ['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'FAKE_PROFILE', 'OTHER'] },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['PENDING', 'RESOLVED', 'REJECTED'] },
          resolutionNote: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          reviewedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      AdminReport: {
        allOf: [
          { $ref: '#/components/schemas/Report' },
          {
            type: 'object',
            properties: {
              reporter: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' } } },
              targetUser: {
                nullable: true,
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' } },
              },
              reviewedBy: {
                nullable: true,
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' } },
              },
            },
          },
        ],
      },
      StorageStatus: {
        type: 'object',
        properties: {
          configured: { type: 'boolean' },
          provider: { type: 'string', enum: ['none', 'local', 's3'] },
          requiredEnvVars: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', nullable: true },
          maxUploadBytes: { type: 'integer' },
          allowedContentTypes: { type: 'array', items: { type: 'string' } },
        },
      },
      UploadTarget: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          publicUrl: { type: 'string' },
          uploadUrl: { type: 'string' },
          method: { type: 'string', enum: ['PUT', 'POST'] },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          expiresAt: { type: 'integer', description: 'Unix epoch seconds' },
          maxBytes: { type: 'integer' },
        },
      },
    },
    responses: {
      ValidationError: {
        description: 'Validation failed (400)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Unauthorized: {
        description: 'Missing, invalid or expired credentials (401)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: 'Authenticated but not allowed to perform this action (403)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource not found (404)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Conflict: {
        description: 'Conflicts with current state: duplicate, invalid transition or overlapping booking (409)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      RateLimited: {
        description: 'Too many requests (429)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      ServiceUnavailable: {
        description:
          'A required external provider is not configured (503). `details.requiredEnvVars` lists what to set.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
} as const;

const options: swaggerJSDoc.Options = {
  definition: swaggerDefinition,
  apis: [routesGlob, configGlob],
};

export const openapiSpec = swaggerJSDoc(options);
