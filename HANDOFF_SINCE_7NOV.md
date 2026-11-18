# Toolroom PWA: everything built after the 7 Nov handoff

Written 17 Nov 2026 (section 8 added 18 Nov) so a Claude Code session can continue the earlier chat. Read `HANDOFF.md` first. The repo code is the source of truth. This file was written from the chat, where the code was edited on scratch copies and then pasted by the owner, so check each item against the repo. Items marked UNCONFIRMED were delivered but the owner has not said they tested them.

## 1. Speed and security audit (done)
- Phase 1: dashboard lathe-log effect now depends on counts, not on the `orders` array. `lib/useOrders.ts` debounces realtime reloads (800 ms, one reload per burst).
- Phase 2: dashboard `allD` effect depends on newest delivery id + count + received count. Inventory loads `tooling_master` dimensions once per factory (`dimsLoaded` ref). New `lib/useVisibleInterval.ts` pauses 60 s polling while the screen is hidden (used in `lib/inventory.tsx` and `lib/stockReminder.tsx`).
- Phase 3: migration 31 `security_hardening` (revoke `order_set_priority` from public and anon, grant to authenticated; `monthly_production` policy to authenticated). `next.config.mjs` with security headers (no CSP on purpose). `npm audit fix` moved Next.js to 16.4.5.
- RLS verified on for all 22 tables; no leftover "open" policies. `lathe_activity_logs` is CNC/owner read, insert only.
- Not done: Phase 4. Supabase response times were 500-800 ms even for tiny queries. Suspected cause: policies call `my_role()` / `can_see()` per row, so wrap as `(select my_role())`. The owner never sent the Supabase compute size, region, or load graphs. Self-hosting the database was discussed and advised against.
- Repo gap: no migration files for 14, 15, 21 (15 was never run), and nothing in the repo creates `lathe_activity_logs` or `monthly_production`. Before go-live, prove the whole database rebuilds from the repo on an empty Supabase project.

## 2. Dimension checklist at dispatch and receipt (done)
- Migration 32: `deliveries.cnc_check` and `plant_check` (jsonb). Shape: `{ items: [{k, spec, v}], at, match?, note? }`. Keys `OD`, `Length`, `OD 2`, `Step depth` must be numbers; `Batta` and `Dimensions` are free text.
- CNC cannot confirm a batch without a complete checklist. The toolroom cross-checks (their own measured values, Matches / Doesn't match, note required on mismatch). A mismatch is recorded and flagged everywhere but does not block receipt.
- Code: `lib/dimCheck.ts` (`checkLines`, `blankCheck`, `checkProblem`, `checkDone`, `itemBad`, `checkText`, `checkResult`, `checkNote`, `orderTool`), `lib/checkView.tsx` (`CheckLines`, `CheckBadge`, `CheckSummary`). Shown on toolroom cards, CNC Ready and History, dashboard monthly orders (checks column), inventory history, and appended columns in three CSV exports.
- `complete_batch(p_order, p_qty, p_note, p_check)` and `receive_delivery(p_delivery, p_qty, p_check)` are the current signatures.

## 3. Orders own their dimensions (done)
- Bug fixed: editing a roller's tool details used to change every past order and stock line. Now `tool_orders` has its own columns `batta_code, od_dim, length_dim, od2_dim, step_id_dim, step_depth_dim`, copied from `tooling_master` by trigger `order_own_dims` when the order is inserted (migrations 33 to 35; 33's `dims` json copy was dropped in 35).
- Screens read the order's columns through `orderTool(o)` in `lib/dimCheck.ts`. `tooling_master` is now only the default that pre-fills a new order. Do not read dimensions from `o.tooling` for display.

## 4. Stock by exact dimension (done)
- Migration 36: `dim_label(type, batta, od, len, od2, step)` builds the label, e.g. `OD 25.4 x L 80 . OD 12 . Step -`. `inventory_moves.dim_key` (default ''), `inventory_stock` view groups by it, the no-negative-stock trigger counts per dimension.
- Migration 37: every function that writes or reads stock carries `dim_key`: transfer (`p_dim_key`), requests (`inventory_requests.dim_key`, `inventory_request_create(..., p_dim_key)`), take-down, `shift_return_stock`, `inventory_search`.
- Migration 38 (the switch): `validate_check`, `receipt_dim_key`; receiving files stock under the dimensions the PLANT measured (fallback to ordered value per dimension). The checklist is now mandatory in the database for both CNC and plant. Batches made before the checklist cannot be received.
- Screens (`lib/inventory.tsx`): stock lines show `dim_key` (fallback to the roller's default dims), Move / Hardened / Take out carry it, Add stock has dimension boxes (label comes from the `dim_label` RPC) and an "add roller size" button, Other factories and Requests name the exact dimension, History shows it.

## 5. Shift sheet: which size was used (done, Option B)
- Migration 39: `shift_tools` primary key is now `(entry_id, tool_type, dim_key)`. `shift_use_stock(...)` helper. `shift_entry_save` takes `p_picks`. When more than one size is in stock for that roller and tool, the sheet must say which size and how many; with one size it is automatic.
- Form asks only when there is a real choice; saved lines show the size.

## 6. Tool life (built, UNCONFIRMED in live testing)
- Migration 40: `machine_tools`, `shift_tool_use`, view `tool_life`. Migration 41: `shift_tools_undo`, `shift_entry_save` now has 16 params ending `p_picks jsonb, p_toolrows jsonb`; `shift_entry_delete` calls the undo.
- Rules: die top and bottom tracked (`TRACKED` in `lib/toolLife.ts`, keep in step with the database function). A machine holds one tool per type at a time. Each line has one row per tool used: kg forged with it and outcome ON / WORN_OUT / REMOVED. The kg must add up to the line weight. The tool already on the machine must be the first row. Only the last row can stay ON. A tool for another roller size must be taken off with 0 kg. WORN_OUT takes one tool out of stock from its own size. Only the latest entry of a machine can be edited or deleted once tools are tracked.
- Code: `lib/toolLife.ts` (switch `TOOL_LIFE`, row helpers, `lifeStats`), `lib/toolLifeReport.tsx` (tab "Tool life" in Shift records), tool cards in `EntryForm` in `lib/shiftSheet.tsx`, saved lines show each tool.
- Owner worried operators may not enter this. It can be switched off with `TOOL_LIFE = false`. Rollback of the database part: `rollback_tool_life_40_41.sql`.
- Known limit: a tool taken off and put on later starts a new record (no serial numbers).

## 7. Error messages next to the box (done in the repo 17 Nov 2026, not yet tried in use)
Problem: errors showed in a banner at the top of the page, so users had to scroll up to see why a form would not save. Shared kit `lib/formErrors.tsx`: `useFormErrors()` returns `{ errs, fail, put, root, onFieldChange }`; `Err` shows the message under a box (`tone="info"` = amber note, key starts with `info:`), `ring()` adds a red border; boxes are wrapped with `data-k="key"`; the page scrolls to the first error; a line above Save says how many boxes need fixing. `Toast({ msg, tone })` shows success messages pinned to the bottom of the screen (green; `tone="warn"` amber).
- Shift sheet (`lib/shiftSheet.tsx`): entry form (all boxes, tool cards, size choices, new roller size, new operator), not running reason, delete, complete or reopen. Verified present in the repo.
- Inventory (`lib/inventory.tsx`): Mover, ActionForm, AddStock (all problems at once, bad dimension boxes red, count line above Save), Locs, TakeDown, OtherFactories request, ReqCard (error at the bottom of the card). MoveTool now says why its button is grey. No error uses the banner any more.
- Toolroom (`app/page.tsx`): all `alert()` pop-ups replaced (add machine, roller details form, send order, receive box, delete / close remaining / make urgent; whole-order errors at the bottom of the order pop-up, key `act:group`). Ordering a tool without details opens the details form with an amber note. A failed receive keeps the box open. The receive box says why Confirm is grey.
- CNC (`app/cnc/page.tsx`): start, stop, confirm batch; the confirm screen says why the button is grey; a failed lathe run-time log shows an amber note under the CNC heading (the batch is still saved).
- Small forms: Header capacity (`lib/production.tsx`) now refuses non-numbers per box (before, "abc" silently cleared the capacity); Rollers per kg (`lib/rollerRates.tsx`) shows a save error in the sticky Save bar and "A number above 0" under bad boxes; Shift sheet download (`lib/sheetDownload.tsx`) shows a failed download in red until the next try.
- Success messages: the top banners in Inventory, Shift sheet and Rollers per kg are replaced by `Toast`. Download and Header capacity keep their message beside the button (their forms stay open).
- Kept on purpose: yes/no `confirm()` questions (delete from order, close remaining, raise priority, rate change over 25%). Could become on-screen Yes/No buttons if the owner wants.
- To test: try each form with empty or wrong values, and one real save each in light and dark theme. The dev server uses the LIVE database (no staging).

## 8. Work done 17-18 Nov 2026 in Claude Code (all builds pass; NOT yet tried in the app or committed)
- **Enter to save**: `enterTo(save, busy)` in `lib/formErrors.tsx` on every form that saves (shift sheet, inventory forms, toolroom add machine / roller details / receive box, CNC confirm batch, Rollers per kg, Header capacity). An inner box (new roller size, new operator) saves only itself. Deliberately NOT on Send order (an order cannot be taken back once the CNC starts). Search and filter boxes have none.
- **Success messages**: `Toast` (bottom of the screen, green; amber for "Saved, stock was short") replaces the top banners in Inventory, Shift sheet and Rollers per kg.
- **Stock screen** (`lib/inventory.tsx`): each roller size opens as a table (Tool, Size, Condition, Location, Pcs, Actions); rows sorted tool, size, state; tool name shown once per group; the action form opens in a row below. "Hardened" is now "Mark as Heat Treated" everywhere users see it (button, History "Heat treated", Add stock conditions). The database still says HARDEN / HARD.
- **Add stock** is one table for a roller size: one location for all, Soft pcs and Heat treated pcs per tool, size boxes open only on rows with a quantity, all lines saved in one insert (all or nothing). Cutter removed from this list.
- **Stock-only tools**: Cutting Quill, Bush Main, Bush Back, Bush Pin, Die Pin (`STOCK_ONLY_LABEL` in `types/database.ts`, codes CUTTING_QUILL etc.), quantity only, no size. Not in orders, shift sheet or Tool Plan. No migration: `inventory_moves.tool_type` is plain text.
- **Named other tools** in Add stock are stored as `tool_type = 'OTHER:<name>'` (`OTHER_PREFIX`), each name its own stock line; typing an existing name in any case joins that line. `stockToolName()` in `types/database.ts` turns any stored tool code into a readable name: use it wherever stock tool names are shown.
- **All Orders** (toolroom): the Tool column shows the order's own dimensions under the tool name (`dims(o)`).
- **Pop-ups**: all `alert()` calls in `app/page.tsx` and `app/cnc/page.tsx` replaced by messages beside the box. `confirm()` yes/no questions kept on purpose.
- **Header capacity** now refuses non-numbers (before, "abc" silently cleared the capacity).
- **Shift sheet entry form** (`EntryForm` in `lib/shiftSheet.tsx`), redesigned in two phases:
  - Phase 1: four numbered steps (What ran, How much, Tools, Remarks), one roller-size box with suggestions (`datalist`; picks by exact label or a single match), roller count as text beside the weight, a "Check:" summary line above Save. Operator is NOT pre-filled (owner's decision).
  - Phase 2: Die Top / Bottom default to a simple view: one tool takes the whole line weight automatically, the operator taps Still on / Worn out / Taken off. "Changed the tool during this line?" opens the detailed editor. A tool left on from another roller size is taken off automatically with 0 kg and a new one goes on. Editing a saved entry builds the simple view from that entry's saved rows (`init.toolRows`), never from what is on the machine now; entries with several tools of one type open in the detailed editor. Saved rows come from `effRows(tt)`. The database function and its rules are unchanged.
- **Tool life report** (`lib/toolLifeReport.tsx`): new first section "What each die and bottom produced, by roller size". Collapsed: per tool type, tools used, kg, rollers, average per tool (counts tools still on). Expanded: "Each tool" (numbered Die Top 1, 2 ... with month and whole-life rollers) and "Day by day" (every sheet line). Source: `shift_tool_use` joined to `shift_entries` and `machine_tools`. Two CSVs: day by day, and each tool. Only lines entered since tool life started (40-41) have this data.
- `next.config.mjs`: `agentRules: false` so `next dev` does not create `AGENTS.md`.
- To test, using real but deletable entries (the dev server writes to the LIVE database): the four shift sheet tool cases (tool already on and still on; worn out next shift; no tool on and more than one size in stock; tool from another roller size), one Add stock with two tools and a named other tool, Mark as Heat Treated, and both tool life CSVs.

## How the pieces link
- A dimension is decided in three places and only the first is editable by hand: the order (copied from `tooling_master` at order time) -> the CNC checklist and plant checklist on the delivery -> the stock line (`receipt_dim_key` from the plant's measurements).
- Stock lines are keyed by `(factory, roller, tool, state, location, dim_key)`. Anything that writes `inventory_moves` must carry `dim_key`.
- `shift_entry_save` is the one function behind the shift sheet. It now handles stock use, picks and tool rows. Edit it by dropping the old signature first.

## Still open (owner decisions or work)
1. Section 7 is built; the owner will check it in normal use. Plan changed 17 Nov 2026: a PC at each place runs the app in the browser most of the time; phones are occasional.
2. Confirm 41 and the tool-life form work on real test entries (night shift 100 kg worn out + 200 kg on, next shift continues it).
3. Before going live: wipe test data; rebuild the database from the migration files on an empty project; make sure files 14, 21 and the DDL for `lathe_activity_logs` and `monthly_production` exist in the repo.
4. Speed Phase 4 (policy lookups, compute size and region).
5. Update `HANDOFF.md` with this file's content once things are confirmed.
6. Older notes still open from the first handoff: the `FactoryTag` colour class, unused dashboard helpers and `lib/dailyProduction.tsx`, and whether `header_machines.current_roller_id` should still preselect rollers.
7. Optional report extras: tool life per operator (the tool life CSVs are done, section 8).
8. Test and commit the section 8 work, then push so the PCs get it.
9. Optional: tidy how stock size labels display (hide the "—" parts) without changing the stored `dim_key`; turn the remaining yes/no `confirm()` pop-ups into on-screen buttons.
