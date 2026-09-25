# Nexora

Nexora is a dual-sided restaurant reservation and floor operations platform. Diners discover venues by locality and book 15-minute slots. Hosts run the floor with live table tiles, a triage queue, order tickets with elapsed timers, and guest CRM. The stack is Next.js 16 + Fastify 5 + PostgreSQL 16.

- [Requirements](docs/REQUIREMENTS.md) · [Critique of the source docs](docs/CRITIQUE.md) · [Architecture](docs/ARCHITECTURE.md) · [Backlog](docs/BACKLOG.md)

## Quick start

```bash
npm install
npm run db:reset        # creates DB "nexora", migrates, seeds demo data
npm run dev             # API on :4000, web on :3000
npm test                # shared unit tests + API integration tests (DB: nexora_test)
```

Requires Node ≥ 20 and a local PostgreSQL (defaults to `postgres://localhost:5432/nexora`; override with `DATABASE_URL`).

Demo staff logins (password `nexora123`): `manager@nexora.dev` (org-wide manager) and `host@nexora.dev` (host at Ember & Oak).
