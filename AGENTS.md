# pi-personal monorepo

Personal iMessage agent (Pi on a Fly Sprite) plus the web, backend, and desktop apps around it. Bun workspaces + Turborepo, scaffolded with Better-T-Stack (`bts.jsonc` holds the exact command).

This git repo is public. Secrets stay in gitignored files on the Mac and on the Sprite.

## Layout

- `apps/sprite/` — the iMessage agent: Bun webhook gateway (`src/`), Pi workspace (`agent/`), provisioning and home-daemon scripts (`scripts/`). Its own `AGENTS.md`, `PRIVACY.md`, and `COST.md` apply to everything under it; read them before touching it.
- `apps/web/` — TanStack Start site (port 3001), Better Auth via Convex, deploys to Vercel (`vercel.json`)
- `apps/desktop/` — Electrobun shell; the future home of Mac daemon management (today `apps/sprite/scripts/install-home.sh` + `home-daemon.py`)
- `packages/backend/` — Convex functions, schema, and the Better Auth component
- `packages/ui/` — shared shadcn/ui primitives
- `packages/config/` — shared `tsconfig.base.json`

## Commands

- Install: `bun install`
- Tests: `bun run test` (Turborepo; today only `apps/sprite` has tests)
- Types: `bun run check-types` (the web task runs `vite build`, so `apps/web/.env` needs `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`)
- Lint/format: `bun run check` / `bun run fix` (Ultracite + Biome; `apps/sprite` is excluded and keeps its own style)
- Web + Convex dev: `bun run dev` (excludes the Sprite gateway; use `bun run dev:sprite` for that)
- Convex without an account: `cd packages/backend && CONVEX_AGENT_MODE=anonymous bunx convex dev` runs a local backend on `127.0.0.1:3210`
- Provision the Sprite: `bun run provision` (same as `apps/sprite/scripts/provision.sh`; needs `apps/sprite/.env`)

`apps/sprite` must stay installable on its own: `provision.sh` uploads only that folder and runs `bun install` there. Keep its dependencies pinned in its `package.json` and do not give it `workspace:` or `catalog:` dependencies.

Do not commit unless asked. Do not push unless asked.

## Boundaries

All of the **Always**, **Ask first**, and **Never** rules in `apps/sprite/AGENTS.md` apply, with paths under `apps/sprite/`. In particular, never read or print `apps/sprite/.env`, `apps/sprite/agent/logins.md`, or `apps/sprite/agent/live-view.md`.

Also treat `apps/web/.env`, `packages/backend/.env.local`, and Convex/Vercel environment values (`BETTER_AUTH_SECRET`, deploy keys) as secret.

Adding a vendor or sending personal data to Convex, Vercel, or the desktop app changes the data flow: update `apps/sprite/PRIVACY.md` and `apps/sprite/COST.md` in the same change.
