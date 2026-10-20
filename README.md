# Coachini API (RivaMeet)

Backend for **RivaMeet**, a sports coach and community platform. Clients find coaches by
sport, location, price and rating, then request sessions; coaches publish a profile, manage
availability, and accept or reject requests. Reviews are only possible after a completed
booking.

On top of that MVP, this repository now implements the first three phases of the RivaMeet
specification:

* **Phase 1** - athlete/coach/admin profiles (avatar, display name, disciplines, level,
  city/country), a configurable object-storage boundary for media, and compatible-profile
  matching ([details](#additional-product-features-phases-1-3)).
* **Phase 2** - blocking, reporting and admin moderation, enforced in discovery.
* **Phase 3** - private text chat with REST history and realtime Socket.IO delivery.
* **Phase 4** - off-platform contact moderation for messages, plus private 1:1 audio/video
  calls over WebRTC with server-issued STUN/TURN configuration.

> The product-facing name is **RivaMeet**. Package names, folders and database objects keep
the original `coachini` identifiers so nothing existing breaks.

* **Runtime:** Node.js 20.19+ (developed and tested on Node 24) with Express 5 and TypeScript
* **Database:** PostgreSQL via Prisma ORM 7 (driver adapter, migrations, no in-memory substitute)
* **Validation:** Zod on every request body, query string and route parameter
* **Auth:** JWT access tokens (HS256) + bcrypt password hashing + role-based authorization
* **Docs:** OpenAPI 3.0 at `/docs` (Swagger UI) and `/docs.json`
* **Tests:** Vitest + Supertest against a **real** PostgreSQL database (226 tests)

---

## Table of contents

1. [Quick start](#quick-start)
2. [Environment variables](#environment-variables)
3. [npm scripts](#npm-scripts)
4. [Database: schema, migrations, seed](#database-schema-migrations-seed)
5. [API reference](#api-reference)
6. [Search and geospatial behaviour](#search-and-geospatial-behaviour)
7. [Security](#security)
8. [Testing](#testing)
9. [Deployment on Northflank](#deployment-on-northflank)
10. [Project structure](#project-structure)
11. [Design decisions](#design-decisions)
12. [Known limitations and notes](#known-limitations-and-notes)

---

## Quick start

### Option A - no Docker required (embedded PostgreSQL)

This repository ships a dev-only helper that runs the official PostgreSQL binaries
locally (`embedded-postgres`). Nothing is mocked: the API and the test suite talk to a real
PostgreSQL server.

```bash
# 1. install dependencies (also runs `prisma generate`)
npm install

# 2. terminal 1 - start PostgreSQL on 127.0.0.1:55432, data in .pgdata/dev
npm run db:start

# 3. terminal 2 - apply migrations, seed the sport catalogue, start the API
npm run migrate:deploy
npm run seed                       # add SEED_DEMO_DATA=true for demo users/coaches
npm run dev                        # http://localhost:4000  (docs: /docs)
```

`.env` is already configured for this flow (it is gitignored; `.env.example` is the template).
If port `55432` is busy, `db:start` picks the next free port and prints the URL - update
`DATABASE_URL` in `.env` accordingly.

### Option B - your own PostgreSQL (Docker, local install, or managed)

```bash
cp .env.example .env
# set DATABASE_URL (and JWT_SECRET) in .env

npm install
npm run migrate:deploy
npm run seed
npm run dev
```

Minimal Docker example for the database itself:

```bash
docker run --name coachini-pg -e POSTGRES_USER=coachini -e POSTGRES_PASSWORD=coachini \
  -e POSTGRES_DB=coachini -p 5432:5432 -d postgres:17
```

### Verify it is running

```bash
curl http://localhost:4000/health
curl "http://localhost:4000/api/v1/coaches?latitude=52.520008&longitude=13.404954&radiusKm=10&sort=distance_asc"
open http://localhost:4000/docs
```

---

## Environment variables

Every variable is validated at startup by Zod (`src/config/env.ts`); the process exits with
a readable message when something is missing or invalid.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `4000` | HTTP port |
| `HOST` | no | `0.0.0.0` | Bind address (keep `0.0.0.0` in containers) |
| `TRUST_PROXY` | no | `1` | Reverse-proxy hops. `1` behind a load balancer; `0` locally |
| `DATABASE_URL` | **yes** | - | PostgreSQL connection string used by the API and the Prisma CLI |
| `SHADOW_DATABASE_URL` | no | - | Only used by `prisma migrate dev`; Prisma creates one automatically when unset |
| `DATABASE_SSL` | no | `false` | `false` \| `true` \| `no-verify` (managed providers usually need `true`) |
| `JWT_SECRET` | **yes** | - | Access-token signing key, **minimum 32 characters** |
| `JWT_EXPIRES_IN` | no | `1h` | Token lifetime (`15m`, `1h`, `7d`, ...) |
| `JWT_ISSUER` | no | `coachini-api` | `iss` claim, verified on every request |
| `BCRYPT_SALT_ROUNDS` | no | `12` | bcrypt cost factor (4-15) |
| `FRONTEND_URL` | no | `http://localhost:3000` | CORS allow-list; comma-separated for multiple origins. `*` is rejected in production |
| `RATE_LIMIT_WINDOW_MS` | no | `900000` | Global rate-limit window (15 min) |
| `RATE_LIMIT_MAX` | no | `300` | Requests per window per IP across the API |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | Requests per window per IP for `/auth/register` and `/auth/login` |
| `LOG_LEVEL` | no | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` |
| `SERVICE_VERSION` | no | `1.0.0` | Reported by `/health` and in the OpenAPI document |
| `CHAT_RATE_LIMIT_MAX` | no | `60` | Messages a single account may send per `RATE_LIMIT_WINDOW_MS` |
| `STORAGE_PROVIDER` | no | `none` | `none` \| `local` \| `s3`. `none` keeps uploads in a documented "not configured" state |
| `STORAGE_BUCKET` | only for `s3` | - | Bucket/container name |
| `STORAGE_REGION` | only for `s3` | `us-east-1` | Provider region |
| `STORAGE_ENDPOINT` | no | - | Custom endpoint for S3-compatible providers (R2, Spaces, MinIO, B2) |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | only for `s3` | - | Credentials used to sign presigned upload URLs |
| `STORAGE_PUBLIC_BASE_URL` | recommended | - | Public base URL (CDN or bucket domain) used to build object URLs |
| `STORAGE_FORCE_PATH_STYLE` | no | `false` | `true` for path-style endpoints (MinIO) |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | no | `300` | Presigned upload URL lifetime |
| `STORAGE_MAX_UPLOAD_BYTES` | no | `5242880` | Maximum upload size (5 MB) |
| `STORAGE_LOCAL_DIR` | no | `.tmp/uploads` | Only used by `STORAGE_PROVIDER=local` (development/test) |
| `SEED_DEMO_DATA` | no | `false` | When `true`, `npm run seed` also creates demo users, coaches, a booking and a review |
| `SEED_DEMO_PASSWORD` | no | `Passw0rd123` | Password for the demo accounts |
| `STORAGE_DOCUMENT_BUCKET` | recommended | `STORAGE_BUCKET` | Dedicated **private** bucket for verification documents (must not be publicly readable) |
| `STORAGE_DOCUMENT_MAX_UPLOAD_BYTES` | no | `10485760` | Maximum size of one verification document (10 MB) |
| `VERIFICATION_REQUIRED_DOCUMENT_TYPES` | no | `DIPLOMA,CERTIFICATION` | Document types that satisfy a submission. Empty = any one document |
| `TEST_DATABASE_URL` | no | - | When set, tests run against this database instead of starting an embedded cluster |
| `TEST_PG_PORT` | no | `55433` | First port tried for the embedded **test** cluster |
| `EMBEDDED_PG_PORT` | no | `55432` | First port tried by `npm run db:start` / `npm run migrate:dev:local` |
| `EMBEDDED_PG_USER` / `EMBEDDED_PG_PASSWORD` / `EMBEDDED_PG_DATABASE` | no | `coachini` | Embedded cluster credentials |
| `MESSAGE_MODERATION_ENABLED` | no | `true` | Scan every REST/Socket.IO message for off-platform contact details |
| `MESSAGE_MODERATION_POLICY` | no | `warn` | `warn` (deliver + warn) \| `block` (reject before persisting) \| `flag` (deliver + admin review queue) |
| `CALL_RING_TIMEOUT_MS` | no | `45000` | How long the callee has to answer before the call is `MISSED` |
| `CALL_DISCONNECT_GRACE_MS` | no | `15000` | Grace after the last socket drops before a call is ended (tab switch / short network loss) |
| `CALL_MAX_DURATION_MINUTES` | no | `240` | Hard ceiling for a connected call, enforced by the stale-session sweep |
| `CALL_INVITE_RATE_LIMIT_MAX` | no | `20` | Call invitations per account per rate-limit window |
| `CALL_SIGNAL_RATE_LIMIT_MAX` | no | `300` | SDP/ICE signalling frames per account per `CALL_SIGNAL_RATE_LIMIT_WINDOW_MS` |
| `CALL_SIGNAL_RATE_LIMIT_WINDOW_MS` | no | `60000` | Signalling rate-limit window |
| `STUN_URLS` | no | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs; empty disables STUN |
| `TURN_URLS` | no | - | Comma-separated TURN URLs (`turn:host:3478?transport=udp`, `turns:host:5349`) |
| `TURN_SHARED_SECRET` | no | - | TURN REST API shared secret (coturn `static-auth-secret`, Metered, ...) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | no | - | Static TURN credentials for providers without the shared-secret scheme (Twilio, Cloudflare) |
| `TURN_CREDENTIAL_TTL_SECONDS` | no | `3600` | Lifetime of minted TURN credentials |

Generate a production secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `tsx watch src/server.ts` - hot-reloading dev server |
| `npm run build` | `prisma generate && tsc -p tsconfig.build.json` -> `dist/` |
| `npm start` | `node dist/server.js` - run the compiled build |
| `npm run typecheck` | `tsc --noEmit` across `src`, `tests`, `scripts`, configs |
| `npm run lint` / `lint:fix` | ESLint (flat config, typescript-eslint) |
| `npm run format` | Prettier over `src`, `tests`, `prisma`, `scripts` |
| `npm run prisma:generate` | Regenerate the Prisma client into `src/generated/prisma` |
| `npm run migrate:dev` | `prisma migrate dev` (interactive; create/apply migrations) |
| `npm run migrate:deploy` | `prisma migrate deploy` (apply committed migrations) |
| `npm run migrate:status` | Show migration state |
| `npm run migrate:reset` | Drop and recreate the schema, then apply all migrations |
| `npm run migrate:dev:local` | Start an embedded PostgreSQL, run `prisma migrate dev`, stop it |
| `npm run seed` | Seed the sport catalogue (+ demo data with `SEED_DEMO_DATA=true`) |
| `npm run seed:local` | Same as `seed` but against an embedded PostgreSQL |
| `npm run db:start` | Start the local embedded PostgreSQL cluster (foreground) |
| `npm run db:status` | Report whether the local cluster is listening |
| `npm test` | Full Vitest suite (unit + integration) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only (starts a real database) |
| `npm run test:watch` | Vitest in watch mode |

---

## Database: schema, migrations, seed

### Models

| Model (table) | Key fields | Notes |
| --- | --- | --- |
| `User` (`users`) | `email` (unique), `passwordHash`, `name`, `phone?`, `role` | `role`: `CLIENT` \| `COACH` \| `ADMIN` |
| `CoachProfile` (`coach_profiles`) | `userId` (unique), `bio`, `certifications`, `hourlyPrice`, `experienceLevel`, `city`, `neighborhood`, `address?`, `latitude?`, `longitude?`, `isPublished` | one profile per coach; coordinates required to publish |
| `Sport` (`sports`) | `name` (unique), `slug` (unique) | seeded catalogue |
| `CoachSport` (`coach_sports`) | composite PK `(coachProfileId, sportId)` | a coach cannot offer the same sport twice |
| `Availability` (`availabilities`) | `coachProfileId`, `startAt`, `endAt`, `isAvailable` | coach working windows |
| `Booking` (`bookings`) | `clientId`, `coachProfileId`, `startAt`, `endAt`, `priceAtBooking`, `status` | status: `PENDING` \| `ACCEPTED` \| `REJECTED` \| `CANCELLED` \| `COMPLETED` |
| `Review` (`reviews`) | `bookingId` (**unique**), `clientId`, `coachProfileId`, `rating`, `comment?` | one review per booking |
| `UserSport` (`user_sports`) | composite PK `(userId, sportId)`, `level?` | athlete disciplines (Phase 1) |
| `Block` (`blocks`) | `blockerId`, `blockedId` (unique pair) | directional block, `CHECK` against self-blocks (Phase 2) |
| `Report` (`reports`) | `reporterId`, `targetType`, `targetId`, `targetUserId?`, `reason`, `status`, `reviewedById?`, `reviewedAt?` | moderation with a consistent review-state `CHECK` (Phase 2) |
| `Conversation` (`conversations`) | `bookingId?` (**unique**), `lastMessageAt?` | private 1:1 chat; booking conversations are unique per accepted booking |
| `ConversationParticipant` (`conversation_participants`) | composite PK `(conversationId, userId)`, `lastReadAt?` | membership + unread tracking |
| `Message` (`messages`) | `conversationId`, `senderId`, `body` | `CHECK` on body length (Phase 3) |
| `MessageModerationFlag` (`message_moderation_flags`) | `messageId`, `conversationId`, `senderId`, `policy`, `matches`, `reviewedById?`, `reviewedAt?`, `reviewNote?` | detector kinds only, never the matched value; ADMIN-only |
| `Call` (`calls`) | `conversationId`, `callerId`, `calleeId`, `type`, `status`, `startedAt`, `answeredAt?`, `endedAt?`, `endedById?` | metadata only - no media, SDP or ICE candidates |
| `CoachVerification` (`coach_verifications`) | `coachProfileId` (**unique**), `status`, `submittedAt`, `reviewedById?`, `reviewedAt?`, `reviewNote?` | one application per coach; **the only source of truth for approval** |
| `CoachVerificationDocument` (`coach_verification_documents`) | `verificationId`, `type`, `storageKey` (**unique**), `contentType`, `sizeBytes`, `isCurrent`, `confirmedAt?` | private object key + metadata only, never the bytes |
| `CoachVerificationEvent` (`coach_verification_events`) | `verificationId`, `type`, `fromStatus?`, `toStatus?`, `actorUserId?`, `actorRole?`, `note?` | append-only audit trail |

`User` also carries the athlete-facing profile fields added in Phase 1: `displayName?`,
`avatarUrl?`, `bio?`, `city?`, `country?`, `level?`.

Conventions:

* tables/columns are mapped to `snake_case` (readable raw SQL), all timestamps are `timestamptz(3)`;
* money is `decimal(10,2)` and is serialized as a 2-decimal **string** (`"45.00"`) so clients
  never lose precision to floating point;
* **the average coach rating is never stored.** It is always derived from `reviews`
  (`AVG`/`COUNT`), so it can never drift out of sync.

### Migrations

```
prisma/migrations/20261012161427_init/                     # generated by `prisma migrate dev`
prisma/migrations/20261012161500_add_check_constraints/    # hand-written invariants
prisma/migrations/20261012233737_phase1_profiles/          # profile fields + user_sports
prisma/migrations/20261012234325_phase2_safety/            # blocks + reports
prisma/migrations/20261012234500_phase2_safety_constraints/ # hand-written invariants
prisma/migrations/20261012235122_phase3_chat/              # conversations + messages
prisma/migrations/20261012235500_chat_constraints/         # hand-written invariants
prisma/migrations/20261013030000_booking_conversations/    # optional unique booking link for chat
prisma/migrations/20261014120000_calls/                    # call log + one active call per conversation
prisma/migrations/20261016120000_coach_verification/       # coach verification + private documents (additive)
prisma/migrations/20261019120000_message_moderation/       # moderation flags queue (additive)
```

All migrations are additive: no table, column or row is ever dropped, so they can be
applied to a database that already holds production data.

The second migration adds constraints Prisma's schema language cannot express:

* `coach_profiles.hourly_price >= 0`, latitude/longitude inside WGS84 ranges;
* `availabilities.end_at > start_at`, `bookings.end_at > start_at`, `bookings.price_at_booking >= 0`;
* `reviews.rating BETWEEN 1 AND 5`;
* a partial index on accepted bookings (`coach_profile_id, start_at, end_at WHERE status = 'ACCEPTED'`)
  to keep overlap checks cheap.

It also documents - but deliberately does not enable - an optional `btree_gist` `EXCLUDE`
constraint that would let PostgreSQL enforce non-overlapping accepted bookings on its own.
Application-level prevention already runs inside `SERIALIZABLE` transactions (see below).

Commands:

```bash
npm run migrate:deploy     # apply committed migrations (idempotent, used on deploy)
npm run migrate:dev        # create + apply a migration while developing
npm run migrate:status
npm run migrate:reset      # destructive: recreate the schema
```

### Seed

```bash
npm run seed                        # sports only (safe in production)
SEED_DEMO_DATA=true npm run seed    # + admin, 2 published coaches, 1 client, 1 review
```

Always created: **Fitness, Boxing, Swimming, Football, Tennis**.
Demo accounts (password `Passw0rd123`): `admin@coachini.test`, `client@coachini.test`,
`anna.coach@coachini.test` (Berlin), `omar.coach@coachini.test` (Hamburg).

---

## API reference

Base path: `/api/v1` - interactive docs at **`/docs`**, machine-readable spec at **`/docs.json`**.

### Response envelope

```jsonc
// success
{ "data": { ... } }

// paginated list
{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3,
                             "hasNextPage": true, "hasPreviousPage": false } }

// error
{ "error": { "code": "CONFLICT", "message": "…", "details": { ... } }, "requestId": "…" }
```

Error codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429),
`SERVICE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500). Stack traces are never returned in
production; every error carries a `requestId` that also appears in the logs
(`X-Request-Id` response header).

### Authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/register` | - | Register a `CLIENT` or `COACH`. Emails are trimmed + lower-cased; duplicates return 409. `ADMIN` is rejected. |
| `POST` | `/api/v1/auth/login` | - | Returns `{ user, accessToken, tokenType, expiresIn }` |
| `GET` | `/api/v1/auth/me` | Bearer | Current user |

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alex@example.com","password":"Passw0rd123","name":"Alex Doe","role":"CLIENT"}'
```

Passwords: bcrypt (cost from `BCRYPT_SALT_ROUNDS`), 8-72 characters, at least one letter and
one number. Hashes are never serialized. Registration and login are rate limited much more
strictly than the rest of the API.

### Sports

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/sports` | Seeded catalogue with `coachCount` (published coaches only) |

### Coaches

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/coaches` | - | Search **published** coaches (filters + pagination below) |
| `GET` | `/api/v1/coaches/{id}` | - | Profile detail + upcoming availability (`id` = CoachProfile id) |
| `GET` | `/api/v1/coaches/{id}/reviews` | - | Reviews + derived rating summary |
| `GET` | `/api/v1/coaches/me/profile` | COACH | Own profile (including unpublished state) |
| `POST` | `/api/v1/coaches/me/profile` | COACH | Create profile (starts unpublished) |
| `PATCH` | `/api/v1/coaches/me/profile` | COACH | Partial update |
| `GET` | `/api/v1/coaches/me/sports` | COACH | Sports I teach |
| `PUT` | `/api/v1/coaches/me/sports` | COACH | Replace sports (`sportSlugs` or `sportIds`) |
| `POST` | `/api/v1/coaches/me/sports` | COACH | Add one sport |
| `DELETE` | `/api/v1/coaches/me/sports/{sportId}` | COACH | Remove one sport |
| `GET` | `/api/v1/coaches/me/availability` | COACH | My availability windows |
| `POST` | `/api/v1/coaches/me/availability` | COACH | Add window (overlaps rejected with 409) |
| `DELETE` | `/api/v1/coaches/me/availability/{availabilityId}` | COACH | Delete window |

**Search parameters** (`GET /api/v1/coaches`):

| Parameter | Type | Notes |
| --- | --- | --- |
| `sport` | string | Sport slug (`boxing`) or name (`Boxing`) |
| `city`, `neighborhood` | string | Case-insensitive exact match |
| `country` | string | Coach's country, from their user profile (Phase 1) |
| `level` | enum | `BEGINNER` \| `INTERMEDIATE` \| `ADVANCED` \| `PROFESSIONAL` (Phase 1) |
| `minPrice`, `maxPrice` | number | Hourly price range (inclusive) |
| `minRating` | number 1-5 | Filters on the derived average rating |
| `latitude`, `longitude` | number | Must be supplied together; enables `distanceKm` |
| `radiusKm` | number ≤ 20000 | Requires coordinates |
| `sort` | enum | `newest` (default), `oldest`, `price_asc`, `price_desc`, `rating_desc`, `rating_asc`, `distance_asc`, `distance_desc` |
| `page` | integer ≥ 1 | default `1` |
| `limit` | integer 1-100 | default `20` |

Filtering rules: only published profiles are returned; all provided filters are combined with
AND; invalid combinations (latitude without longitude, radius without coordinates, distance
sort without coordinates, `minPrice > maxPrice`, out-of-range values) return **400** with a
field-level `details` array.

Publishing rules: a profile can only set `isPublished: true` when it has **coordinates** and
**at least one sport**; otherwise `PATCH` returns 400 explaining exactly what is missing.
New profiles always start unpublished.

### Bookings

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/bookings` | CLIENT | Request a session (`PENDING`) |
| `GET` | `/api/v1/bookings/mine` | Bearer | CLIENT: my requests; COACH: requests on my profile; ADMIN: all. Supports `status`, `page`, `limit` |
| `GET` | `/api/v1/bookings/{id}` | Bearer | Participants and admins only (otherwise 403) |
| `PATCH` | `/api/v1/bookings/{id}/accept` | COACH (owner) | `PENDING → ACCEPTED` |
| `PATCH` | `/api/v1/bookings/{id}/reject` | COACH (owner) | `PENDING → REJECTED` |
| `PATCH` | `/api/v1/bookings/{id}/cancel` | client or coach of the booking | `PENDING`/`ACCEPTED → CANCELLED` |
| `PATCH` | `/api/v1/bookings/{id}/complete` | COACH (owner) | `ACCEPTED → COMPLETED` |
| `POST` | `/api/v1/bookings/{id}/review` | CLIENT (owner) | Review a completed booking |
| `GET` | `/api/v1/notifications/mine` | Authenticated user | Latest 20 in-app alerts and unread count |
| `PATCH` | `/api/v1/notifications/mine/read` | Authenticated user | Mark own alerts as read |

State machine:

```
PENDING ──accept(coach)──▶ ACCEPTED ──complete(coach)──▶ COMPLETED  (terminal)
   │                          │
   ├──reject(coach)──▶ REJECTED (terminal)
   └──cancel(client|coach)──▶ CANCELLED (terminal) ◀──cancel(client|coach)──┘
```

Rules enforced in `src/services/booking.service.ts`:

* only `CLIENT` accounts can create bookings; the client is always the authenticated user
  (`clientId` is never read from the request body);
* `startAt` must be in the future; sessions must last between 15 minutes and 12 hours;
* the whole requested window must fit inside **one** open (`isAvailable: true`) availability
  window of that coach, otherwise **409**;
* the coach profile must be published (otherwise 404) and belongs to someone else;
* overlapping **accepted** bookings for the same coach are rejected with **409**, and so is a
  second active (`PENDING`/`ACCEPTED`) request from the same client for the same slot;
* `priceAtBooking` snapshots `hourlyPrice × duration` (rounded to 2 decimals) at request time,
  so later price changes cannot alter existing bookings;
* cancellation is allowed from `PENDING` and `ACCEPTED` only - `REJECTED`, `CANCELLED` and
  `COMPLETED` are terminal and return 409 with the allowed source statuses;
* invalid transitions return **409** listing the allowed statuses; foreign users get **403**.

Each successfully created booking also creates one unread `BOOKING_REQUEST` notification
for the coach user's database ID in the same PostgreSQL transaction. The coach can retrieve
it from the authenticated notification inbox; when Socket.IO is running, the server also
sends `notification:new` to that user's authenticated socket room. The coach studio shows
the unread count, alert details, and pending booking requests. Notification rows are
uniquely tied to a booking, so a booking cannot create duplicate alerts. No email, SMS, or
push provider is configured or used.

**Race conditions.** Creation and acceptance both read-then-write, so they run in
`SERIALIZABLE` transactions with a small retry on serialization failures
(`src/utils/transaction.ts`). The test suite fires two concurrent accepts of overlapping
bookings and asserts that exactly one succeeds.

Example:

```bash
# client requests a session
curl -X POST http://localhost:4000/api/v1/bookings \
  -H "Authorization: Bearer $CLIENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"coachProfileId":"<uuid>","startAt":"2026-06-01T09:00:00.000Z","endAt":"2026-06-01T10:00:00.000Z"}'

# coach accepts
curl -X PATCH http://localhost:4000/api/v1/bookings/<id>/accept \
  -H "Authorization: Bearer $COACH_TOKEN"
```

### Reviews

* Only the client who owns the booking may review it (403 otherwise).
* Only `COMPLETED` bookings can be reviewed (409 otherwise, with `currentStatus` in `details`).
* One review per booking - enforced both in the service and by a **unique index** on
  `reviews.booking_id`, so concurrent duplicate submissions still yield exactly one review.
* `rating` is an integer 1-5 (`CHECK` constraint in the database as well);
  `comment` is optional, 3-1000 characters.
* `GET /api/v1/coaches/{id}/reviews` returns a paginated list plus
  `meta.summary = { averageRating, reviewCount }`, both derived on the fly.

### Health

`GET /health` returns `200` when PostgreSQL is reachable and `503` otherwise
(flat JSON, not wrapped in `data`, so platform probes can read it):

```json
{ "status": "ok", "service": "coachini-api", "version": "1.0.0", "uptimeSeconds": 12.3,
  "timestamp": "2026-10-12T16:32:12.038Z",
  "checks": { "database": "up", "databaseLatencyMs": 1 } }
```

---

## Additional product features (Phases 1-3)

### Profiles and disciplines (Phase 1)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/profile/me` | Bearer | My profile (account + athlete fields, disciplines, coach link) |
| `PATCH` | `/api/v1/profile/me` | Bearer | Partial update; send `null` to clear a field |
| `GET` | `/api/v1/profile/{userId}` | - | **Privacy-safe** public profile (never email/phone/report data) |
| `GET` | `/api/v1/profile/me/sports` | Bearer | My disciplines |
| `PUT` | `/api/v1/profile/me/sports` | Bearer | Replace disciplines (`sportSlugs`/`sportIds`, optional `level`) |
| `POST` | `/api/v1/profile/me/sports` | Bearer | Add one discipline |
| `DELETE` | `/api/v1/profile/me/sports/{sportId}` | Bearer | Remove one discipline |

Account types are `CLIENT` (athlete), `COACH` (expert) and `ADMIN`. A club/organisation
type is **deferred**: the schema is user-centric (one `CoachProfile` per coach) and adding
organisations needs a membership model - documented rather than half-built.

### Matching (Phase 1)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/matches/suggestions` | Bearer | Compatible coaches ranked by discipline overlap, then city/country and level |

`GET /api/v1/coaches` gained `level` and `country` filters, and now accepts an optional
Bearer token so a signed-in caller's blocks are filtered out of the results. The response
`meta.basis` explains which viewer attributes drove the ranking. A swipe UI is deliberately
**not** implemented - it would imply a mutual-match system, which is not built here.

### Object storage (Phase 1)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/storage/status` | Bearer | `configured`, `provider`, `requiredEnvVars`, `reason` |
| `POST` | `/api/v1/storage/uploads` | Bearer | Presigned upload target for an `avatar`/`post` object |
| `PUT` | `/api/v1/storage/local` | signed token | **Dev-only** raw upload endpoint for `STORAGE_PROVIDER=local` |

The API issues presigned URLs and never proxies bytes in production. With no provider
configured every media endpoint returns `503` + `details.requiredEnvVars`, and text-only
features keep working. Any S3-compatible provider works (AWS S3, Cloudflare R2,
DigitalOcean Spaces, MinIO, B2).

### Safety: blocking and reporting (Phase 2)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/blocks` | Bearer | Users I have blocked |
| `POST` | `/api/v1/blocks` | Bearer | Block a user (idempotent) |
| `DELETE` | `/api/v1/blocks/{userId}` | Bearer | Unblock |
| `POST` | `/api/v1/reports` | Bearer | Report a user (post/message targets return 400 until those exist) |
| `GET` | `/api/v1/reports/mine` | Bearer | Reports I filed (paginated) |
| `GET` | `/api/v1/reports/{id}` | Bearer | One of my reports |
| `GET` | `/api/v1/admin/reports` | ADMIN | Moderation queue (filter by `status`, `targetType`) |
| `GET` | `/api/v1/admin/reports/{id}` | ADMIN | Report detail |
| `PATCH` | `/api/v1/admin/reports/{id}/resolve` | ADMIN | `PENDING -> RESOLVED` (records reviewer + timestamp) |
| `PATCH` | `/api/v1/admin/reports/{id}/reject` | ADMIN | `PENDING -> REJECTED` |

Blocking is bidirectional for discovery and messaging. The reporter projection never
exposes reviewer identity; the admin projection is only reachable through ADMIN routes.

### Private chat (Phase 3)

Booking cards expose a conversation link after acceptance and keep it available for
completed bookings; pending, rejected and cancelled bookings cannot open or send messages. Both
participants open the same conversation with
`POST /api/v1/conversations/booking/{bookingId}`; the API derives participant IDs from
the booking and enforces one booking-linked conversation. Existing participant-based
read receipts and the authenticated Socket.IO channel are reused.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/conversations` | Bearer | Inbox: other participant, last message, unread count |
| `POST` | `/api/v1/conversations` | Bearer | Start/reuse a private conversation (`participantId`) |
| `GET` | `/api/v1/conversations/{id}/messages` | Bearer | History, oldest-first, paginated |
| `POST` | `/api/v1/conversations/{id}/messages` | Bearer | Send a message (per-account rate limited) |
| `PATCH` | `/api/v1/conversations/{id}/read` | Bearer | Record a read receipt |

Membership and the block relation are re-checked on **every** REST request and socket
event, so a leaked conversation id is useless to a third party and a block takes effect
immediately.

Realtime (Socket.IO, same port as the HTTP API):

```js
const socket = io('http://localhost:4000', { auth: { token: accessToken } });
socket.emit('conversation:join', { conversationId }, (ack) => console.log(ack));
socket.emit('message:send', { conversationId, body: 'Hello' }, (ack) => console.log(ack));
socket.on('message:new', (message) => console.log(message));
```

No message is ever reported as "delivered" unless it was actually persisted. Audio/video
calls and off-platform contact moderation are described below.

### Message moderation (off-platform contact sharing)

Every message - REST **and** Socket.IO - passes through `chat.service.sendMessage`, which
runs `moderation.service` *before* the row is inserted and before anything is broadcast. A
client therefore cannot bypass moderation by switching transport, and a blocked message is
never persisted.

Detected contact formats:

* phone numbers in local and international forms, with spaces, dots, dashes, parentheses or
  slashes, including Arabic-Indic digits and `0049 (0) …`;
* email addresses, including `[at]` / `(at)` / `[dot]` and spaced variants;
* WhatsApp, Facebook/Messenger, Instagram and Telegram links (including `wa.me`, `fb.me`,
  `t.me`, `instagr.am` and `domain[.]com` obfuscation);
* other social profile URLs (LinkedIn, TikTok, Snapchat, X/Twitter, Discord, YouTube, ...);
* social handles introduced by a network name (`telegram: @name`). A plain `@coach` mention
  is **not** flagged.

False positives are avoided by looking for contact *formats* rather than words: dates
(`2026-10-19`), times (`10:00`), prices (`€45`), sets/reps (`3 sets of 12 at 60 kg`) and
normal coaching discussion are not matched. Detection never echoes the matched value -
warnings and flags contain only the detector kind and label.

Policy (`MESSAGE_MODERATION_POLICY`):

| Policy | Behaviour |
| --- | --- |
| `warn` (default) | Persist and deliver the message; the sender receives a warning |
| `block` | Reject with `400 VALIDATION_ERROR` + `details.moderation`; nothing is stored or broadcast |
| `flag` | Persist and deliver the message, and create an admin review row in the same transaction |

Existing messages are never deleted, rewritten or scanned again. `MESSAGE_MODERATION_ENABLED=false`
disables the check without a deploy. The frontend reads the active policy from
`GET /api/v1/conversations/moderation-policy` and only blocks locally under `block`; `warn`
and `flag` messages are sent and the server outcome drives the toast. Every path is still
re-validated server-side.

Administrators review flagged messages (ADMIN-only):

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/admin/message-flags` | Queue, filter `reviewed=true\|false`, paginated |
| `PATCH` | `/api/v1/admin/message-flags/{id}/review` | Record reviewer, timestamp, optional note |

The flag row stores detector kinds/labels only - never the phone number, email address or
profile URL.

### Audio / video calls (WebRTC)

Calls are available **only inside a booking conversation** whose status is `ACCEPTED` or
`COMPLETED`, between its two participants. Membership, the block relation and the call role
are re-checked on every invite and every signalling frame. Media is peer-to-peer; the server
relays SDP/ICE but never stores or records it. `GET /api/v1/calls/config` returns the ICE
servers plus `ringTimeoutMs` and `disconnectGraceMs`.

Lifecycle: `RINGING -> ACCEPTED -> ENDED`, plus `REJECTED`, `MISSED` (ring timeout / callee
unreachable) and `CANCELLED` (caller hangs up while ringing). At most one live call exists per
user and per conversation; the database enforces the per-conversation rule with a partial
unique index. On boot and every 60 s, a sweep marks stale `RINGING` calls `MISSED` and closes
`ACCEPTED` calls older than `CALL_MAX_DURATION_MINUTES`.

Reconnection and ICE recovery:

* a dropped signalling socket is **not** a hang-up: the server waits
  `CALL_DISCONNECT_GRACE_MS` and only ends the call if the user still has no sockets;
* the client shows a `reconnecting` phase, reconnects the socket automatically and restores
  the call instead of tearing media down;
* a transient peer-connection `disconnected` waits before recovery; `failed` recovers
  immediately; the callee (the offerer in this flow) performs ICE restarts on request, with
  up to three attempts before reporting `call.connectionFailed`;
* hiding a tab or changing OS focus never ends a call. Browsers may still throttle timers or
  suspend background media - background-call continuity is **not** promised or simulated.

#### STUN / TURN configuration

```bash
# Public STUN is enough for most home networks. Nothing secret lives here.
STUN_URLS=stun:stun.l.google.com:19302

# TURN is required when both peers are behind symmetric NAT / restrictive firewalls.
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349

# Preferred: TURN REST API shared secret (coturn static-auth-secret, Metered, ...).
# The API mints short-lived <expiry>:<userId> credentials with HMAC-SHA1 per request;
# the secret itself never reaches the browser.
TURN_SHARED_SECRET=<long-random-secret>
TURN_CREDENTIAL_TTL_SECONDS=3600

# Alternative for providers without the shared-secret scheme (Twilio, Cloudflare):
# TURN_USERNAME=...
# TURN_CREDENTIAL=...
```

Rules enforced at startup:

* `TURN_URLS` requires exactly one credential scheme - either `TURN_SHARED_SECRET` or both
  `TURN_USERNAME` and `TURN_CREDENTIAL`; the process refuses to boot otherwise;
* credentials without `TURN_URLS` are rejected;
* `STUN_URLS`/`TURN_URLS` are server-side only. Never put TURN secrets in
  `frontend/src/environments/*` or a `VITE_*`/`NG_APP_*` variable - anything bundled there
  is public. The browser only ever receives the per-request `iceServers` array from the
  authenticated API, and TURN credentials are never logged.

coturn example:

```conf
listening-port=3478
tls-listening-port=5349
use-auth-secret
static-auth-secret=<same value as TURN_SHARED_SECRET>
realm=rivameet.example.com
min-port=49160
max-port=49200
```

#### Production deployment

The signalling design targets a **single API process**: the live-call registry and Socket.IO
(and its rate-limit windows) are in memory. If you run more than one replica, add the
Socket.IO Redis adapter and move the registry/sweep to shared storage first; otherwise two
replicas can each accept a call for the same conversation (the database index still rejects
the second insert, but lifecycle timers would be split). Sticky sessions alone are not a
substitute.

Checklist:

1. Put the API behind a proxy/load balancer that forwards WebSocket upgrades on
   `/socket.io` and allows long-lived connections (idle timeout ≥ 5 minutes).
2. Open TURN `3478/udp` and `3478/tcp` (plus `5349/tcp` for `turns:`) and the relay port
   range (`49160-49200` in the example) between the TURN server and clients.
3. Set `FRONTEND_URL` to the exact deployed origin(s) - Socket.IO uses the same allow-list.
4. Set `TRUST_PROXY` to the number of proxy hops so rate limiting sees real client IPs.
5. Verify: two accounts, an accepted booking, a call on Wi-Fi, then repeat with one peer on
   a mobile hotspot; if it only connects with TURN, check the TURN URL/TTL and relay ports.
6. Keep `JWT_SECRET`, `TURN_SHARED_SECRET` and storage keys in the platform secret manager;
   never in git, the frontend bundle or log output.

---

## Coach verification

A coach becomes publicly discoverable and bookable **only** when their verification
application is `APPROVED` *and* the profile satisfies the existing publication rules
(coordinates + at least one sport). The gate is enforced server-side in discovery, the
public profile endpoint and booking creation - hiding UI controls is never the boundary.

### Lifecycle

```
DRAFT --submit--> PENDING --markInReview--> IN_REVIEW --approve--> APPROVED
  ^                 |                            |--reject--> REJECTED --resubmit--> PENDING
  |                 |--requestInfo--> NEEDS_INFO --+                         ^
  +--------- upload/remove documents --------+----- resubmit ----------------+
```

| Status | Meaning |
| --- | --- |
| `DRAFT` | Documents can still be changed; not visible to administrators as work |
| `PENDING` | Submitted and awaiting review (documents locked) |
| `IN_REVIEW` | An administrator is reviewing it |
| `NEEDS_INFO` | More or corrected documents are required (the coach can edit and resubmit) |
| `APPROVED` | Verified by an administrator |
| `REJECTED` | Refused with a reason; the coach can correct and resubmit |

Every status change is recorded in the append-only event history. Only an ADMIN can approve
or reject an account after manually reviewing the submitted documents.

### Frontend

* **Coach studio** (`/coach/dashboard`) gained a **Verification** tab: status and what it
  means for visibility, required-document checklist, upload with progress (validation errors
  surfaced verbatim), document list with remove, submit/resubmit, reviewer feedback and the
  audit history.
* **Admin queue** (`/admin/verifications`) lists applications with status/date filters and
  pagination, shows coach details, streams private documents, displays review history, and
  offers mark-in-review / approve / reject / request-info behind an explicit note-backed
  confirmation. A second view lists published-but-unverified coaches so
  they can be recorded as manually approved.
* Routes are guarded by a client-side `adminGuard`, and every `/admin/*` request is
  re-authorized server-side, so the guard is convenience only.
* All copy ships in English, French and Arabic (RTL).

### Coach endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/coaches/me/verification` | COACH | Application, documents, reviewer feedback, history |
| `GET` | `/api/v1/coaches/me/verification/status` | COACH | Official status + whether the profile is publicly visible |
| `POST` | `/api/v1/coaches/me/verification/documents` | COACH | Presigned **private** upload target (server-generated key) |
| `POST` | `/api/v1/coaches/me/verification/documents/{documentId}/confirm` | COACH | Verifies existence, size and real file type |
| `DELETE` | `/api/v1/coaches/me/verification/documents/{documentId}` | COACH | Remove a document while the application is editable |
| `POST` | `/api/v1/coaches/me/verification/submit` | COACH | Submit/resubmit (checks the configured document requirements) |

### Admin endpoints (all ADMIN-only)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/admin/verifications` | Queue with `status`, `coachProfileId`, `submittedFrom/To`, pagination |
| `GET` | `/api/v1/admin/verifications/unverified-coaches` | Published coaches without approval (rollout queue) |
| `GET` | `/api/v1/admin/verifications/{id}` | Detail: documents, reviewer, audit history |
| `GET` | `/api/v1/admin/verifications/documents/{documentId}/file` | Streams the private document (`no-store`, never a public URL) |
| `PATCH` | `/api/v1/admin/verifications/{id}/in-review` | `PENDING` -> `IN_REVIEW` |
| `PATCH` | `/api/v1/admin/verifications/{id}/approve` | `PENDING`/`IN_REVIEW` -> `APPROVED` (does **not** publish the profile) |
| `PATCH` | `/api/v1/admin/verifications/{id}/reject` | `-> REJECTED` (reason required) |
| `PATCH` | `/api/v1/admin/verifications/{id}/request-info` | `-> NEEDS_INFO` (note required) |
| `POST` | `/api/v1/admin/verifications/grandfather` | Manual, auditable approval for coaches that predate verification |

### Document handling

* Keys are always server-generated (`verifications/<verificationId>/<uuid>.<ext>`), so a
  client filename can never influence the storage path (no traversal, no cross-application
  overwrite).
* Only `application/pdf`, `image/jpeg` and `image/png` are accepted, and the stored bytes
  are re-checked against their **file signature** on confirm - a renamed file is rejected
  and discarded.
* Documents are never served from a public URL: admins receive them through an
  authenticated, `Cache-Control: no-store` API stream.
* `STORAGE_PROVIDER=local` (development/test) refuses to run in production; production must
  use an S3-compatible bucket, ideally a dedicated private one (`STORAGE_DOCUMENT_BUCKET`).
* Unconfirmed uploads older than an hour are cleaned up on the next upload attempt.

### Rollout: existing coaches

No coach is auto-approved. The additive migration creates the tables and nothing else, so a
coach that predates verification simply has no application and is therefore **not**
discoverable until an administrator reviews them:

1. deploy the migration while the queues are otherwise quiet;
2. open `/admin/verifications/unverified-coaches`;
3. for each known coach, use **Record manual approval** (stores reviewer, timestamp and a
   reason) - or ask them to upload their diploma like a new coach;
4. the coach reappears in search as soon as their application is `APPROVED` (and their
   profile is still published with coordinates + at least one sport).

---

## Search and geospatial behaviour

Distance search uses the **Haversine formula executed inside PostgreSQL** as a single
parameterized statement (`src/services/coach.service.ts`):

* no PostGIS or extra extension is required, so the schema stays portable across managed
  providers;
* every user value is bound as a query parameter (`Prisma.sql` tagged templates) - no string
  concatenation. The only raw SQL fragment is the `ORDER BY` clause, built from a validated
  enum;
* results are filtered and paginated in SQL, then enriched with each coach's sports in a
  second query;
* `averageRating`/`reviewCount` come from a `LEFT JOIN` on a `reviews` aggregate, so they are
  always current and can be filtered (`minRating`) and sorted in the same statement.

The JavaScript reference implementation in `src/utils/geo.ts` mirrors the SQL expression, and
the test suite asserts the two agree (a Hamburg coach is reported ~255.25 km from Berlin,
matching the unit test).

**PostGIS upgrade path.** If you need index-accelerated radius search at large scale:

```sql
CREATE EXTENSION postgis;
ALTER TABLE coach_profiles ADD COLUMN location geography(Point, 4326);
UPDATE coach_profiles SET location = ST_MakePoint(longitude, latitude)::geography;
CREATE INDEX coach_profiles_location_idx ON coach_profiles USING GIST (location);
```

then replace the Haversine expression with `ST_Distance(location, ST_MakePoint($lng, $lat)::geography) / 1000`
and use `ST_DWithin` for the radius filter. This requires a database where you may create
extensions (self-managed PostgreSQL, or a provider that allows it).

---

## Security

* **Authentication:** JWT access tokens, HS256, issuer-checked, expiry enforced; the secret
  must be ≥ 32 characters and comes from the environment only.
* **Passwords:** bcrypt with a configurable cost; hashes never leave the process;
  login responses for unknown emails are indistinguishable from wrong passwords and take the
  same time (dummy bcrypt comparison), so accounts cannot be enumerated.
* **Authorization:** `authenticate` populates `req.user`; `authorize(...roles)` restricts
  routes. Cross-resource access is checked per resource (owning coach for booking actions,
  booking participants for reads, review owner for reviews).
* **Role escalation:** the public register endpoint only accepts `CLIENT` or `COACH`;
  `ADMIN` is provisioned out of band. There is no endpoint that changes a user's role.
* **Input validation:** Zod schemas with `.strict()` reject unknown fields instead of
  silently ignoring them.
* **Transport/headers:** Helmet (with a relaxed CSP only for the Swagger UI route), CORS from
  an explicit `FRONTEND_URL` allow-list (`*` is refused in production), JSON body limit of
  100 kB, `X-Powered-By` disabled.
* **Rate limiting:** global limiter plus a stricter one for authentication endpoints;
  `/health` is exempt so platform probes are never throttled.
* **Chat and call authorization:** conversation membership, the block relation and the
  booking status are re-checked on every REST request and every Socket.IO event. Signal
  frames are only relayed between the two participants of a live call; the caller cannot
  choose the recipient. Conversation rooms are joined server-side only after a membership
  check, and call events go to private `user:<id>` rooms that a client cannot join itself.
* **Secrets:** `JWT_SECRET`, `TURN_SHARED_SECRET`/static TURN credentials and storage keys
  live in server environment variables only. The Angular bundle contains no credentials;
  the browser receives short-lived, per-request ICE credentials. Signal payloads are never
  persisted or logged, and moderation warnings/flags never repeat the matched value.
* **Abuse limits:** chat messages, call invitations and signalling frames each have a
  per-account budget, separate from the global HTTP limiter; every socket event payload is
  Zod-validated and signalling data is capped at 64 KB.
* **Logging:** Pino with redaction of `Authorization`, cookies, `password` and tokens;
  errors are logged with the request id and full detail server-side while clients get a
  generic message.

Note: tokens are stateless, so a role change only takes effect on the next login. Use short
`JWT_EXPIRES_IN` values (default `1h`) if that matters to you.

---

## Testing

```bash
npm test                 # everything
npm run test:unit        # pure functions (Haversine)
npm run test:integration # HTTP + database
```

Requirements: tests need a **real PostgreSQL**. Two modes:

1. **No configuration (default):** an embedded PostgreSQL cluster is started automatically on
   a free port with its data in `.pgdata/test`, migrations are applied, and the cluster is
   stopped afterwards. This is how the suite runs on a machine without Docker.
2. **`TEST_DATABASE_URL` set:** that database is used instead (ideal for CI with a service
   container). Migrations are applied to it before the run. Use a dedicated database - its
   tables are truncated between tests.

```bash
# CI example
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coachini_test npm test
```

Coverage (**226 tests, 0 failures**):

| Suite | Tests |
| --- | --- |
| `tests/integration/auth.test.ts` | 25 |
| `tests/integration/bookings.test.ts` | 22 |
| `tests/integration/coaches.test.ts` | 21 |
| `tests/integration/reviews.test.ts` | 21 |
| `tests/integration/profile.test.ts` | 13 |
| `tests/integration/safety.test.ts` | 11 |
| `tests/integration/matching.test.ts` | 7 |
| `tests/integration/chat.test.ts` | 12 |
| `tests/integration/realtime.test.ts` | 7 |
| `tests/integration/calls.test.ts` | 18 |
| `tests/integration/moderation.test.ts` | 5 |
| `tests/integration/storage.test.ts` | 4 |
| `tests/integration/storage-local.test.ts` | 4 |
| `tests/unit/storage.test.ts` | 8 |
| `tests/unit/geo.test.ts` | 9 |
| `tests/integration/verification.test.ts` | 21 |
| `tests/unit/ai-analysis.test.ts` | 13 |
| `tests/unit/moderation.test.ts` | 9 |

What those tests verify:

| Area | What is verified |
| --- | --- |
| Registration | access token issued, no password material in responses, case-insensitive duplicate detection (409), invalid payloads (400), `ADMIN` self-registration rejected, unknown fields rejected, malformed JSON rejected |
| Login | valid/invalid credentials, identical 401 for unknown email vs. wrong password, missing fields |
| `/auth/me` | valid token, missing/malformed/tampered tokens (401) |
| Role permissions | client cannot create a coach profile, coach cannot request bookings, client cannot accept, private routes require auth |
| Coach search | published-only, sport (slug + name), city/neighborhood, price range, `minRating`, combined filters, radius + `distanceKm`, sorting by distance/price/rating, pagination metadata, 13 invalid-parameter cases |
| Distance | SQL vs. JavaScript Haversine parity, radius exclusion, sort order |
| Profile management | publish requires coordinates + at least one sport, duplicate profile 409, partial updates, sports add/replace/remove, availability overlap 409, unknown sport 400 |
| Verification | lifecycle (submit -> in review -> approve/reject/needs-info), document requirements, upload confirmation including the file-signature check, cross-coach ownership (IDOR) rejection, admin-only review, audit history, grandfathered approval |
| Verification enforcement | unverified coaches are absent from search, suggestions, sport counts, public detail and booking creation; approval alone never publishes a profile |
| Message moderation | phone/email/social/obfuscated detection, ordinary-coaching false positives, policy mapping (warn/block/flag), no matched value echoed, REST + Socket.IO enforcement, authenticated policy endpoint, ADMIN-only flag review |
| Calls | handshake auth, participant/booking/block authorization, incoming delivery only to the callee, accept/reject/end lifecycle, ring timeout, disconnect grace and reconnect, ICE restart relay, signalling size/rate limits, call log access |
| Bookings | price snapshot (incl. later price change), future-only, availability fit, unpublished coach 404, session length bounds, client overlap 409 |
| Overlap prevention | accepted overlaps rejected with the conflicting booking id, back-to-back slots allowed, slot reusable after cancellation, **concurrent accepts produce exactly one success** |
| Transitions | accept/reject/cancel/complete ownership rules and terminal-state 409s |
| Reviews | eligibility (completed + owner only), duplicate prevention (sequential and concurrent), rating/comment validation, paginated listing with rating summary |
| Aggregates | `averageRating`/`reviewCount` in search and detail, derived (never stored) |
| Database constraints | `CHECK` constraints reject out-of-range ratings and inverted time ranges even when Prisma is bypassed |
| Service | `/health` reports the database check, unknown routes return a structured 404 with `requestId` |

---

## Deployment on Northflank

The included `Dockerfile` builds and runs the API; `docker-compose`-style extras are not
required.

### 1. Create the database

In the Northflank project, add a **PostgreSQL** add-on (or point at an external managed
PostgreSQL). Copy its connection string - you need the internal one for the service.

### 2. Create the service

1. **New service → Build from repository**, select this repository and branch.
2. **Build:** Dockerfile at `/Dockerfile` (the default). The image installs dependencies,
   generates the Prisma client and compiles TypeScript to `dist/`.
3. **Port:** `4000`, protocol **HTTP**, set as **public** if the API is called from the
   frontend/browser.
4. **Health check:** HTTP `GET /health` (expects `200`; the image also declares a
   `HEALTHCHECK`).
5. **Resources:** 0.2-0.5 vCPU / 512 MB is enough for the MVP.

### 3. Set environment variables

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `HOST` | `0.0.0.0` |
| `TRUST_PROXY` | `1` (Northflank terminates TLS in front of your container) |
| `DATABASE_URL` | the add-on/external connection string (append `?schema=public`) |
| `DATABASE_SSL` | `true` for most managed providers (use `no-verify` only if the provider uses a self-signed certificate) |
| `JWT_SECRET` | at least 32 random characters (never commit it) |
| `JWT_EXPIRES_IN` | e.g. `1h` |
| `FRONTEND_URL` | your deployed frontend origin(s) - see below |
| `LOG_LEVEL` | `info` |
| `SEED_DEMO_DATA` | `false` (leave unset in production) |

### 4. Run migrations (one-off job)

Migrations must run **before** the new release serves traffic. Create a **job** in the same
project that uses the same image and repository, with the same environment variables, and set
the command to:

```bash
npx prisma migrate deploy
```

Run it as a **pre-deploy/release job** (or manually before each deploy). Optionally seed the
sport catalogue in the same job:

```bash
npx prisma migrate deploy && npx prisma db seed
```

`prisma db seed` only creates the sport catalogue unless `SEED_DEMO_DATA=true`.

> The runtime image keeps `devDependencies` on purpose so the Prisma CLI is available to the
> migration job. To slim it down, add `npm prune --omit=dev` in the final stage and run
> migrations from a separate job image.

### 5. Setting the frontend CORS URL

`FRONTEND_URL` is the CORS allow-list (`src/app.ts`). Only requests whose `Origin` header
matches are allowed; requests without an `Origin` (server-to-server, curl, mobile apps) are
always allowed, and wildcards are refused when `NODE_ENV=production`.

* Single origin: `https://app.coachini.com`
* Several origins (comma-separated): `https://app.coachini.com,https://staging.coachini.com`
* Preview deployments: add each preview origin, or keep a staging service with a matching
  `FRONTEND_URL`. Never use `*` in production - the process refuses to start.

After changing the value, **restart/redeploy** the service (CORS is read at boot from a frozen
config). Verify with:

```bash
curl -i -H "Origin: https://app.coachini.com" https://<your-service>/health | grep -i access-control
```

### 6. Coach verification: safe deployment order

The backend runs on Railway and the frontend on Vercel. Verification adds a schema change
and requires private document storage, so deploy in this order:

1. **Configure private document storage.** Set `STORAGE_PROVIDER=s3` with
   `STORAGE_BUCKET`/`STORAGE_REGION`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`
   (plus `STORAGE_ENDPOINT`/`STORAGE_FORCE_PATH_STYLE` for non-AWS providers) and, strongly
   recommended, a dedicated **private** `STORAGE_DOCUMENT_BUCKET`. The bucket must not allow
   anonymous `GetObject` (the API still never returns a public URL for a document, but the
   bucket policy is the second line of defence).
2. **Back up the database** (Railway: create a manual backup / snapshot of the PostgreSQL
   service).
3. **Apply the additive migration** as a one-off Railway job using the same image and
   variables as the service:

   ```bash
   npx prisma migrate deploy
   ```

   It only creates `coach_verifications`, `coach_verification_documents`,
   `coach_verification_events` and four enums; no table, column or row is dropped or
   rewritten, so it is safe to run against production data. Do **not** run
   `prisma migrate reset` or any `db push` variant.
4. **Deploy the backend**, then check `/health` and `/docs.json`
   (`paths` should include `/api/v1/admin/verifications`).
5. **Deploy the frontend** (Vercel build; the API base URL stays in
   `frontend/src/environments/environment*.ts`).
6. **Verify with one test coach**: register as COACH, upload a diploma, submit, review it in
   `/admin/verifications`, then confirm the coach appears in search only after approval.
7. **Verify the logs** contain no document contents, signed URLs or credentials, then work
   through `/admin/verifications/unverified-coaches` to review coaches that predate the
   feature.

### 7. Graceful shutdown

`src/server.ts` handles `SIGTERM`/`SIGINT`: it stops accepting connections, waits up to 10 s
for in-flight requests, disconnects Prisma, and exits. Rolling deploys therefore do not drop
requests.

---

## Project structure

```
.
├── Dockerfile                      # multi-stage build (Northflank-ready)
├── .env.example                    # every variable, no secrets
├── eslint.config.mjs               # flat ESLint config
├── package.json                    # scripts + pinned dependencies
├── prisma.config.ts                # Prisma 7 config (datasource, migrations, seed)
├── tsconfig.json                   # ESM/NodeNext, strict
├── tsconfig.build.json             # build-only (src -> dist)
├── vitest.config.ts                # test runner + real PostgreSQL test setup
├── prisma/
│   ├── schema.prisma               # data model
│   ├── seed.ts                     # sports catalogue (+ optional demo data)
│   └── migrations/
│       ├── 20261012161427_init/migration.sql
│       ├── 20261012161500_add_check_constraints/migration.sql
│       └── migration_lock.toml
├── scripts/
│   ├── embedded-postgres.ts        # real PostgreSQL binaries for dev/tests
│   ├── dev-db.ts                   # `npm run db:start` / `db:status`
│   └── with-embedded-db.ts         # run any command against an embedded database
├── src/
│   ├── app.ts                      # Express app factory (security, CORS, docs, routes)
│   ├── server.ts                   # entry point, boot probe, graceful shutdown
│   ├── config/                     # env (Zod), logger (Pino), prisma client, swagger, constants
│   ├── controllers/                # thin HTTP layer
│   ├── services/                   # business rules (auth, coaches, bookings, reviews, sports,
│   │                               #   profiles, storage, matching, blocks, reports, chat)
│   ├── middleware/                 # authenticate, authorize, validate, errorHandler, rateLimit, requestId
│   ├── realtime/                   # Socket.IO chat transport (shares the HTTP server + JWT)
│   ├── routes/                     # routers + OpenAPI annotations
│   ├── schemas/                    # Zod request schemas
│   ├── types/                      # Express type augmentation
│   ├── utils/                      # errors, http envelope, jwt, password, geo, presenters, transactions
│   └── generated/prisma/           # generated Prisma client (gitignored)
└── tests/
    ├── setup/                      # globalSetup (real Postgres) + per-worker env
    ├── helpers/                    # API + database helpers
    ├── integration/                # auth, coaches, bookings, reviews, profiles, safety,
    │                               #   matching, chat, realtime, storage
    └── unit/                       # geo, storage
```

---

## Design decisions

* **Prisma 7 with the `pg` driver adapter** (`@prisma/adapter-pg`) and a generated client in
  `src/generated/prisma`. `prisma.config.ts` owns the datasource URL because Prisma 7 no
  longer loads `.env` automatically or accepts `url` in the datasource block.
* **ESM everywhere** (`"type": "module"`, `module: NodeNext`). Prisma 7 ships as ESM; the
  generated client compiles cleanly to `dist/` and runs under plain Node, `tsx` and Vitest.
* **No in-memory database, ever.** Tests run against real PostgreSQL (embedded when
  `TEST_DATABASE_URL` is absent); the only thing the embedded helper provides is the server
  binary, not a substitute engine.
* **Ratings are derived, never stored.** Search joins a `reviews` aggregate instead of keeping
  a denormalized `averageRating` column, so there is a single source of truth.
* **Money is `numeric(10,2)`** and serialized as strings; `priceAtBooking` snapshots the
  agreed amount.
* **Overlap safety in the application, portability in the schema.** Serializable transactions
  with retries keep the behaviour portable; the PostGIS/`btree_gist` upgrades are documented
  rather than required.
* **Thin controllers, fat services.** Business rules live in `src/services`, so they are
  testable independent of Express and reusable by future transports (webhooks, jobs, queue
  consumers).
* **Open-ended architecture:** payments, the community feed, events, mentorship and push
  notifications are still out of scope, but each is a new `src/services` + `src/routes` pair -
  nothing in the current design blocks them (e.g. `Booking.status` can gain `PAID`/`REFUNDED`
  without touching existing transitions).
* **Storage is a boundary, not a vendor.** `src/config/storage.ts` resolves the provider
  from environment variables and `src/services/storage.service.ts` exposes presigned upload
  targets. Swapping providers is configuration, not code.
* **Thin controllers, fat services, one chat rulebook.** REST and Socket.IO both call
  `chat.service`, so transport-specific permission drift is impossible.
* **Realtime shares the HTTP server.** Socket.IO is attached to the same `http.Server` in
  `src/server.ts` and authenticates with the same JWT, so there is no second port, no second
  auth path and no separate deployment.

---

## Known limitations and notes

* **Later phases are not implemented yet.** Community feed/posts, events and challenges,
  mentorship, push notifications, the rest of the Angular admin back-office (only the coach
  verification queue exists today), the Flutter Android app
  and payments (Phases 4-10 of the specification) are **not** built. The report at the end
  of the working session lists them with the intended approach. There is no fake data or
  simulated external delivery anywhere in the implemented phases.
* **Object storage and push require credentials.** Avatar/post upload endpoints answer
  `503` with `details.requiredEnvVars` until an S3-compatible bucket is configured. Nothing
  is written to local production disk (`STORAGE_PROVIDER=local` is refused in production).
* **Reports support USER targets only.** `POST`/`MESSAGE` targets are rejected with `400`
  because those entities do not exist yet; the contract is already stable for when they do.
* **No push notifications, payments, SMS or email delivery.** Booking alerts are persisted
  in-app and delivered in real time over the existing authenticated Socket.IO connection;
  no external notification provider is configured.
* **Coaches may also cancel** their own `PENDING`/`ACCEPTED` bookings (in addition to clients).
  Documented in the OpenAPI operation description and enforced in `cancelBooking`.
* **Reviews are immutable** - there is no update/delete endpoint, and no moderation tools.
* **Stateless roles:** authorization trusts the token's `role` claim, so a role change takes
  effect at the next login.
* **`pg` deprecation notice:** Node's test output may show
  `DeprecationWarning: Calling client.query() when the client is already executing a query`.
  It originates inside Prisma's own `@prisma/adapter-pg` when queries are pipelined on one
  connection (concurrent requests or `Promise.all`). All queries still execute and the
  concurrency tests pass; it is an upstream notice about a future `pg` 9 change, not an
  application error. Application code awaits its own statements sequentially inside
  transactions.
* **Single-region, single-database MVP:** no read replicas, no caching layer, no background
  job runner.
#   R I i v a M e e t _ B a c k e n d -  
 