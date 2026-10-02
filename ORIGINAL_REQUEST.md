# Original User Request

## 2026-10-01T20:29:07Z

A unified, client-ready restaurant guest, reservation, and floor management platform built in a phased manner within the existing repository, delivering an end-to-end demonstration of guest booking, host floor triage, and POS management.

Working directory: c:\Users\bomkumarmo\Downloads\nexora
Integrity mode: development

Reference Material:
- Redline v2 Specification: `c:\Users\bomkumarmo\Downloads\nexora\DOC-20261001-WA0002.docx.pdf`
- Plan Pack Decisions & Domain Engine: `c:\Users\bomkumarmo\Downloads\nexora\Restaurant-Platform-Implementation-Plan-Pack\restaurant-platform-plan\`

## Requirements

### R1. Core Domain Engine Integration & Test Harness
Implement the enterprise business rules in the shared domain package in a modular, phased manner.
- Port the business rule engine (BR-01 through BR-35) covering dynamic turn times, multi-table combinations, fair void attribution, and 8-state reservation lifecycle (`REQUESTED`, `CONFIRMED`, `ARRIVED`, `SEATED`, `LATE`, `COMPLETED`, `CANCELLED`, `NO_SHOW`).
- Ensure all business rule golden test suites pass cleanly.

### R2. End-to-End API and Multi-Market Engine
Upgrade the backend API to support the full client demo flow with dual-market support.
- Support configurable dual-market currency and locale settings (USD `$` and INR `₹`) per venue.
- Upgrade reservation scheduling to support dynamic party-size turn times, table reset buffers (`T_reset`), and multi-table allocations.
- Implement fair void attribution so that non-guest voids (kitchen burns, server entry errors) do not penalize diner profile metrics.
- Expose floor dwell alerts evaluated against predicted duration (100% amber, 125% red).

### R3. Client-Showcase UI Journeys (End-to-End Product)
Deliver an interactive, polished client demo flow connecting guest and staff experiences:
- **Guest Journey**: Mobile-responsive booking flow with live booking tracker displaying the expanded reservation states (including `ARRIVED` and `LATE`).
- **Host / Front-of-House Journey**: Real-time floor plan with table status tiles, multi-table party visibility, and dynamic dwell color alerts.
- **POS / Manager Journey**: Order management interface demonstrating void classification and profile metric isolation.

## Acceptance Criteria

### Test & Build Integrity
- [ ] Shared domain test suite passes with 100% success rate (`cmd /c npm test -w packages/shared` or equivalent).
- [ ] TypeScript compilation across all packages and apps passes without type errors (`cmd /c npm run check` or `tsc --noEmit`).
- [ ] The API (`apps/api`) and Web frontend (`apps/web`) start successfully and serve client traffic without unhandled runtime exceptions.

### Client Demo Verification
- [ ] A user can book a table, transition through `CONFIRMED` → `ARRIVED` → `SEATED` → `COMPLETED` (or `LATE`), and verify the status live on the guest tracking page.
- [ ] Host floor view correctly reflects dynamic dwell warnings: a table seated past 100% of expected duration displays amber, and past 125% displays red.
- [ ] A POS order adjustment categorized as `KITCHEN` or `SERVER_ENTRY` does not increment the customer's profile void penalty counter.
- [ ] A demo restaurant configured in USD formats pricing in `$`, while a venue configured in INR formats in `₹`.
