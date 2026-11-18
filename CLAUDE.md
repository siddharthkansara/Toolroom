# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read first, in this order, before changing anything:**
1. `HANDOFF.md`: what the app is, the data model, the screens and migrations 01-30.
2. `HANDOFF_SINCE_7NOV.md`: everything after that (migrations 31-41, checklists, stock by dimension, shift-sheet sizes, tool life, error messages) and what is still open.

The code is the source of truth. If a handoff file and the code disagree, trust the code and tell the owner.

## Who you are working with
Siddharth, the owner. Not a developer. Shop users have low digital literacy: big tap targets, minimal typing, English only, field labels always visible above inputs, no clutter. Times are IST. From 17 Nov 2026 the app runs mostly on a PC at each place (browser web app); phones are occasional, so layouts must work well with mouse and keyboard as well as touch.

## How to work
- Make small, targeted edits. Do NOT rewrite whole files. For big features, share a short plan with your assumptions first, then work in phases and STOP after each phase for his confirmation.
- Run `npm run build` after each phase and report the result (it is also the type check; there are no tests or lint). Say plainly what is untested.
- Orders, dimensions, stock and the shift sheet are linked. Check "How the pieces link" in `HANDOFF_SINCE_7NOV.md` before touching any of them.

## Commands
```bash
npm run dev     # needs .env.local with NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
npm run build
```

## Architecture
- Next.js App Router + React 19 + Tailwind 3 + Supabase. Everything is client-side; the browser talks to Supabase with the anon key, so **real security is in the database** (RLS + `security definer` functions).
- Routes: `/` toolroom kiosk (toolroom, owner), `/cnc` (cnc, owner), `/dashboard` (owner), `/login`. Each page is wrapped in `<Guard allow={...}>` from `lib/auth.tsx`, which is a UX guard only and exposes `role`/`factory` via `useAuth()`. Toolroom users are pinned to one factory; the owner can switch.
- Feature modules live in `lib/` and are imported by the pages. Shared helpers: `supabase.ts` (client + loosely typed `rpc()`), `useOrders.ts` (orders/deliveries with realtime reload, `dt()` IST formatting, `gkey()`), `factories.tsx` (machine ids look like `PEW:HD-1`), `useVisibleInterval.ts`.
- Multi-step writes are Postgres functions called through `rpc(...)`, not several client-side table writes. Inventory is a ledger (`inventory_moves`) summed by the `inventory_stock` view, keyed by roller + tool type + `dim_key`.
- `types/database.ts` is hand-written.

## Database changes
- SQL is pasted by the owner into the Supabase SQL Editor (not `supabase db push`). Give it as a new numbered file in `supabase/migrations/` (next is 42; check the folder first). Keep ALL migration files. Read the header comment of related files for prerequisites.
- Follow the existing pattern: `security definer set search_path = public`, role checks via `my_role()` / `can_see()` / `can_write()`, `revoke ... from public, anon` + `grant ... to authenticated`.
- Say clearly when SQL is untested and give a check query. There is no staging database: call out anything that changes behaviour for live users.
- Never leave new function versions beside old ones with different argument lists: `drop function if exists` the old signature first.

## Mistakes that already happened (do not repeat)
1. Module-level `const` helpers declared BELOW the component cause "before initialization".
2. Never put a freshly built array (e.g. `orders`) in a `useEffect` dependency list. Use primitives or stable state.
3. New tables and views must be added to the `Database` block in `types/database.ts`.
4. The global `JSX` namespace is not available. Use `ReactElement`.
5. `now()` is constant inside a transaction. Use `clock_timestamp()` where time order matters.
6. A tool-style prop can be a whole record, not an id (e.g. `machine` in `EntryForm` is a `HeaderMachine`). Check the type before using it in a query.
7. Light theme is CSS overrides of Tailwind `slate-*` classes in `app/globals.css`. Any new colour class needs an override there, or it is unreadable in light mode.
8. Dimension values reach stock only through the database function `dim_label`. Never build a stock dimension label in app code.

## Switches and rollbacks
- Tool life: switch off in the app with `TOOL_LIFE = false` in `lib/toolLife.ts`. `TRACKED` there must match the database function.
- Full database removal of tool life: `rollback_tool_life_40_41.sql` (kept outside `migrations/`; it is not a migration).
