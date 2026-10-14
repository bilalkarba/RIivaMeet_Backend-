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

> The product-facing name is **RivaMeet**. Package names, folders and database objects keep
the original `coachini` identifiers so nothing existing breaks.

* **Runtime:** Node.js 20.19+ (developed and tested on Node 24) with Express 5 and TypeScript
* **Database:** PostgreSQL via Prisma ORM 7 (driver adapter, migrations, no in-memory substitute)
* **Validation:** Zod on every request body, query string and route parameter
* **Auth:** JWT access tokens (HS256) + bcrypt password hashing + role-based authorization
* **Docs:** OpenAPI 3.0 at `/docs` (Swagger UI) and `/docs.json`
* **Tests:** Vitest + Supertest against a **real** PostgreSQL database (160 tests)

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
| `TEST_DATABASE_URL` | no | - | When set, tests run against this database instead of starting an embedded cluster |
| `TEST_PG_PORT` | no | `55433` | First port tried for the embedded **test** cluster |
| `EMBEDDED_PG_PORT` | no | `55432` | First port tried by `npm run db:start` / `npm run migrate:dev:local` |
| `EMBEDDED_PG_USER` / `EMBEDDED_PG_PASSWORD` / `EMBEDDED_PG_DATABASE` | no | `coachini` | Embedded cluster credentials |

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

Unhandled concerns are unchanged: **no audio/video calls** are implemented (that needs a
real WebRTC/SFU provider) and no message is ever reported as "delivered" unless it was
actually persisted.

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

Coverage (**98 tests, 0 failures**):

| Suite | Tests |
| --- | --- |
| `tests/integration/auth.test.ts` | 25 |
| `tests/integration/bookings.test.ts` | 22 |
| `tests/integration/coaches.test.ts` | 21 |
| `tests/integration/reviews.test.ts` | 21 |
| `tests/integration/profile.test.ts` | 13 |
| `tests/integration/safety.test.ts` | 11 |
| `tests/integration/matching.test.ts` | 7 |
| `tests/integration/chat.test.ts` | 9 |
| `tests/integration/realtime.test.ts` | 4 |
| `tests/integration/storage.test.ts` | 4 |
| `tests/integration/storage-local.test.ts` | 4 |
| `tests/unit/storage.test.ts` | 8 |
| `tests/unit/geo.test.ts` | 9 |

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

### 6. Graceful shutdown

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
  mentorship, push notifications, the Angular admin back-office, the Flutter Android app
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