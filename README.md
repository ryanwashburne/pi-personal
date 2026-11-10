# pi-personal

A personal iMessage agent on a [Fly Sprite](https://fly.io/sprites/), plus a website, a Convex backend, and an Electrobun desktop app. Built on [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack) with Bun workspaces and Turborepo.

| Package | What it is |
| --- | --- |
| `apps/sprite` | The agent: Sendblue webhook gateway, Pi workspace, Sprite provisioning, home daemon. See [`apps/sprite/README.md`](apps/sprite/README.md). |
| `apps/web` | TanStack Start website with Better Auth |
| `apps/desktop` | Electrobun desktop app |
| `packages/backend` | Convex backend |
| `packages/ui` | Shared shadcn/ui components |
| `packages/config` | Shared TypeScript config |

## Getting started

```bash
bun install
```

### Convex

Link a Convex project (prompts you to log in):

```bash
bun run dev:setup
cd packages/backend
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
bunx convex env set SITE_URL http://localhost:3001
```

To try it without an account, run a local backend instead: `CONVEX_AGENT_MODE=anonymous bunx convex dev` from `packages/backend`.

Copy `CONVEX_URL` and `CONVEX_SITE_URL` from `packages/backend/.env.local` into `apps/web/.env` as `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`.

### Run

```bash
bun run dev          # web on http://localhost:3001 + Convex
bun run dev:desktop  # Electrobun shell with web HMR
bun run dev:sprite   # the Sprite gateway locally (needs apps/sprite/.env)
```

### Check

```bash
bun run test
bun run check-types
bun run check
```

## Moving from the single-package layout

The Sprite code moved from the repo root into `apps/sprite`. Git does not move ignored files, so on a machine that already had a checkout, move the local secrets once after pulling:

```bash
mv .env apps/sprite/.env
mv agent/logins.md apps/sprite/agent/logins.md
```

Move any other ignored state you keep locally under `agent/` (`live-view.md`, `.pi/mcp.json`, `memory/*`) the same way. The root `.gitignore` still ignores the old `/agent/` path so nothing left behind gets committed. The Sprite itself is unaffected: `provision.sh` still installs to `/home/sprite/pi-personal` and `/home/sprite/agent`.

## Deploy

- Website: Vercel (`bun run deploy:setup`, `bun run env:production`, `bun run deploy:prod`)
- Agent: `bun run provision`
