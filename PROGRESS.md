# Progress Log

## 2026-07-25 — TSS dropped `EventKey`; the importer defaulted instead of failing
A FA26 refresh pulled at 4:31 PM produced an export that looked fine and was
badly wrong. TSS no longer sends the top-level `EventKey` field the importer
grouped lectures on — **0 of 20,944 events carried it**. `e.get("EventKey",
"001")` returned the default for every one, so every lecture group in every
course merged into a single "A" group:
- **MATH 20C**: four lectures all coded `A00`; its 26 discussions re-sequenced
  `A01`–`A26` with no lecture to hang off (correct: `A00`–`A06`, `B00`–`B08`,
  `C00`–`C06`, `D00`–`D06`).
- **ANTH 295**: `A81`–`V81` became `A81`–`A102`.
- **Finals**: one per course instead of one per group — 143 FI rows lost.
- **~3,400 of 7,956 sections changed code.** Section code is part of the
  natural key that carries section ids forward, so shipping this would have
  emptied the saved schedule of anyone holding one — the same damage as the
  2026-07-23 renumbering, arriving by a different door. The export was caught
  and held before it reached TritonPlan.

Why nothing caught it: `refresh-catalog.mjs` and `deploy.sh` both guard against
the *same* natural key getting a *different* id. Here the key itself changed, so
both gates read it as "3,400 sections retired, 3,300 new" and passed.

Fixes (`tss/import_fa26.py`):
- `group_key()` reads the lecture group off `EventAbbr`
  (`"<lecture>-<subsection>-<method>"`, e.g. `002-003-DI` → `002`), present on
  20,944/20,944 events, and falls back to `EventKey` if it ever returns.
- **No default.** An event that can't be placed returns `None`, and the import
  aborts before writing anything rather than emitting a plausible single-group
  catalog. A missing field is now a stop, not a shrug.
- `detect_placeholder_instructors()` had the *same* `EventKey` read as part of
  its "same lecture group of the same course" test — with the field gone that
  test silently widened to "same course". It flagged the same 19 names either
  way on this dump, so nothing shipped wrong, but it was luck; it now uses
  `group_key()` too.
- `tss/test_import_fa26.py` (new, offline/synthetic): asserts two lectures stay
  two groups with a final each, that `group_key` survives the field rename, and
  that an ungroupable dump exits non-zero.

Re-imported from the same 4:31 PM dump: section codes now match the live
catalog exactly (MATH 20C, ANTH 295, BILD 1, CSE 101 verified identical), and
churn against live is **29 dropped / 44 added out of 7,956** — ordinary
two-day movement, down from 3,412/3,299.

## 2026-07-23 — Calendar block render overhaul (ported from TritonPlan)
Sahir asked for the block formatting fix to be pushed here too. Same change
as tritonplan.com's emulator (kept 1:1 — port future calendar edits both ways):
- **96px/hour** grid (was 60) — the smallest scale where a 50-min class fits
  time strip + code + room + instructor + Remove/Change with nothing clipped;
  grid backgrounds/gutter updated to match (half-hour line at 48px).
- **Honest block heights** (no hover-reveal needed; buttons pinned to the
  block's bottom edge, always visible); blocks sorted by start time.
- **Compact mode** for sub-~35-min blocks (strip + code + buttons; detail
  lines return on hover, which also expands lane-split conflict halves to
  full column width).
- **Container queries**: buttons slim down in narrow day columns (mobile) and
  stack inside conflict halves — no more horizontal overflow; text lines
  ellipsize instead of clipping mid-glyph.
- **Dynamic grid range**: 1h before the earliest block to 1h after the last
  (empty -> 8am–6pm); Finals view same treatment.
- Verified with the same automated matrix as TritonPlan (real courses +
  8 edge-case events: 30-min, back-to-back, overlapping, late-night, weekend,
  long-title, TBA; per-block no-clip/buttons-in-bounds/lane-overlap asserts
  at 1440px + 390px; finals + empty-grid checks) — all green.
- NOTE: local rebuild churned site/data/catalog.json ids (fresh seed);
  reverted — CI rebuilds data deterministically from data/parsed, and
  shipping id churn would break users' saved schedules (section_pk refs).

## 2026-07-22 — Fix "instructor teaching 16 classes" placeholder bug (r/UCSD)
- A viral r/UCSD post ("Professor Michael Holst teaching 16 classes this fall?") exposed a **data** bug, not a search bug: searching instructor "holst" returned 16 MATH courses (Calc I → grad Math Methods). Root cause — UCSD's TSS lists a department's **instructor of record** (usually the chair) as the instructor for sections with no real instructor assigned yet, so that one name spreads across many unrelated courses. Real WebReg shows these as "Staff".
- Proof it's a placeholder, not real: Holst appears as instructor on 150 sections that **overlap in time** — e.g. MATH 10A + 20B + 105 all at MWF 2:00–2:50pm simultaneously (35 physically-impossible conflicts). No human teaches 16 distinct courses at once.
- Fix in `tss/import_fa26.py` → `detect_placeholder_instructors()`: flags any instructor whose meetings overlap across **≥3 distinct courses** (the ≥3 threshold clears genuine cross-listings, which produce exactly 2) and blanks the name so the frontend renders "Staff". Caught **16** chair/coordinator placeholders across MATH, PHIL, CSE, POLI, NANO, MUS, EDS, PHYS, etc. (Holst, Graeve, McKenzie, McAuley, Desposato, Weibel…). Name-agnostic, so it self-corrects on every future TSS refresh.
- Surgical: MATH 10A groups A/B/C keep their real instructors (Bowers, Tilton); only the placeholder group D → Staff. 1,711 real instructors preserved.
- The search bar itself was verified fully functional — `holst`→0, `bowers`→MATH 10A, subject+courseno, simple text (`calculus`→11), title (`analysis`→64) all correct on live :5070. The filter was faithfully returning corrupted source data; fixed at the import layer + rebuilt `site/data/catalog.json`.
- **Not deployed** — production push awaits Sahir's OK (WebReg deploy rule).

## 2026-07-22 — Total planned units counter (preview)
- New readout on the left of the "My schedule:" row — `Total units: 8.00 (2 classes)`. Sums `units` across all non-event schedule items, hides when the schedule is empty, re-renders on every schedule change (`renderTotalUnits()` called from `renderSchedule()`), so it stays put across List/Calendar/Finals/Map tabs. Custom events excluded.
- Small gray 12px text matching the header row — visible but unobtrusive; hidden in print along with the rest of `.sched-hdr`.
- Verified with Playwright on the static build: hidden when empty → 4.00 after one plan → 8.00 after two, cross-checked against the List-view Units column; screenshots at 1336/1600/2560.
- Deployed to **staging → /preview/ only** (commit 4182713); production (main) untouched pending Sahir's OK.

## 2026-07-21 — Manual "Add Event" on the schedule
- New **Add Event** link in the schedule tab bar (returns the classic-WebReg chrome link removed in feedback round 1 — now as a real feature): add any weekly block (work, clubs, gym) with name, days, start/end (15-min ticks, 7am–10pm), optional location.
- Events are full citizens of the schedule: gold blocks in Calendar, own rows in List (status "Event"), counted by the conflict engine (banner + red borders + the same warn-then-allow confirm flow as planning a class), Remove/Change buttons everywhere classes have them.
- Implemented 100% client-side in `webreg.js` (localStorage `webreg_fa26_events_v1`, negative ids so they never collide with section pks) — zero backend changes, so Flask dev and the static GitHub Pages build behave identically. Events are stored **per named schedule** and follow it through copy/rename/delete (migration hooks in `onSchedNameChange`).
- Verified: 12-step Playwright E2E (validation, conflict warn, list/calendar render, persistence across reload, edit, remove) green on both Flask :5070 and the static build, plus a 6-step schedule-migration suite; screenshots at 1336/1440/2560 (`scratchpad ev_*.png` during dev).

## 2026-07-21 — Distribution playbook
- Wrote `docs/DISTRIBUTION.md`: full channel-by-channel plan (Reddit follow-up + mod sidebar ask, class-year Discords, YikYak timing, org emails — CSES/ACM/TESC/AS, Guardian + Triton media pitches, advisor outreach, faculty of mega-courses), email templates, enrollment-window timing calendar, analytics-before-outreach step, and the caution to keep Registrar/ITS out of the loop while data comes from scraping. Launch post ("I brought WebReg Back!!!") sits at ~376 upvotes but is archived — follow-up post is the top action.

## 2026-07-21 — Integration pass (all builders merged, E2E green)
- Seeded `data/webreg.db` (DEMO term = real SP15 CSE data, 4 courses / 39 sections; FA26 placeholder awaits TSS import).
- Fixed 5 integration bugs: default port 5060→**5070** (browsers block 5060/SIP as unsafe), `/api/appointment` response shape, final-exam dates lost between scraper format and UI (seed.py now normalizes FI rows into `days`), waitlist position display (queue length vs your position), DI-before-LE row ordering in results/confirm.
- Verified every API endpoint incl. error paths via curl; 19-step headless-Playwright E2E all passing (enroll → list/calendar → conflict banner + red blocks → waitlist → change → drop → finals → advanced search → term switch → appointment).
- Screenshots of all 5 views at 1336/1600/2560 in `docs/research/verify/final_*.png`, no horizontal scroll at any width. Full detail: `docs/research/INTEGRATION_REPORT.md`.

## 2026-07-21 — FA26 LIVE (real data landed) 🎉
- **Cracked the TSS data source.** The new system is SAP; its "Schedule of Classes" Fiori app is served by OData v4 service `yucsd_con_module_sb/…/yucsd_con_module_servicedef/0001`. The crashy TSS search UI is bypassed entirely — with Sahir's captured session I query the backend directly.
- Key entity sets: `YUCSD_CON_MODULE` (course list, defaults to current term = FA26), `YUCSD_CON_EVENTS` (sections: teaching method, instructor, seats/limit/waitlist, human `Sched` string with days/times/room + Final Examination line), `YUCSD_CON_MODULE_SCHED` (structured meeting times). Term keys: `Peryr=2026, Perid=2`.
- Dumped the full FA26 term to `data/tss_fa26/` (git-ignored): **1,768 courses, 8,431 events, 7,408 meetings, 7,107 instructors**.
- `tss/import_fa26.py` maps it into WebReg's format: courses → lecture groups (A/B/C…) → discussion rows (A01..) + lab rows (A50..) + final-exam FI rows, real rooms/instructors/seats. → `data/parsed/FA26/<DEPT>.json` (153 subjects, committed) and FA26 set as default term.
- Seeded: **FA26 = 1,766 courses / 8,061 rows**, FA25 = 570/3,778 (legacy scrape), DEMO. Verified live at http://localhost:5070: CSE 100 shows Paul Cao, Galbraith Hall 242, 100 seats, 12/09/2026 final.
- Data-source recipe for re-runs: `tss/connect.py` (SSO capture) → session in `tss/state.json` → the dump+`import_fa26.py`+`seed.py`. Note `tss/import_tss.py` was the generic first-pass importer; `import_fa26.py` is the working one built against the real service.

## 2026-07-21 — Project start (ultracode build)
- Recon: legacy Schedule of Classes still live (browser UA required; terms end at SU26/S326 — **FA26 exists only in TSS**). Server intermittently 500s "Max Sessions Exceeded" (enrollment-season load) → scraper needs retry/backoff.
- Scaffold: Flask app (`app.py`, port 5070 — moved off 5060 during integration: Chrome/Firefox block 5060 as an unsafe SIP port), SQLite schema (`schema.sql`), repo `SahirSSharma/webreg-revival` (private) created and pushed.
- Research workflow launched: WebReg UI spec from real screenshots, SOC HTML format, TSS recon, feature inventory → `docs/research/`.

### Data-quality sweep (FA26)
1,766 courses · 153 subjects · 8,061 section rows · 5,888 enrollable rows with seat counts · 1,216 finals. ~2,422 rows have no meeting day/time — verified these are legitimately-TBA sections (grad tutorials, independent study, research), exactly as WebReg displays them.

## 2026-07-21 — Feedback round 1 (Feedback (1).pdf)
All 8 items implemented:
1. Removed the fake MY TRITONLINK nav tab strip (Current Students / Advising & Grades / …).
2. Term selector shows **only Fall 2026** (client filters `/api/terms` to FA26).
3. Removed the external-link ↗ glyphs next to Catalog / Prerequisites / Resources / Evaluations (and everywhere else) — `.popout` now `display:none`.
4. **Bug fixed:** calendar-block Remove/Change buttons were cut off — raised min block height to 92px and blocks expand on hover (`height:auto`, overflow visible) so buttons are always reachable.
5. Removed the email ✉ glyph next to instructor names.
6. **Can now plan multiple of the same class** (the key scheduling feature): dropped the "already enrolled" duplicate-course block and the section UNIQUE constraint; any course/section can be planned repeatedly to compare options.
7. Removed the Enroll/Waitlist actions everywhere — planning-only. Results action is a single **Plan**; schedule rows/blocks use Remove + Change; status is always "Planned"; wording updated.
8. Removed the Add Event button.
DB rebuilt (schema change), verified live at :5070 (screenshots in docs/research/verify/fb_*.png).

## 2026-07-21 — Feedback: planned-state button
Once a section is planned it can't be planned again — its Plan button turns into a dark, non-interactive "Planned" chip (`.planned-chip`, #0A4A65). Backend rejects a duplicate of the same section (409); the results grid re-renders on any schedule change so Plan↔Planned stays in sync (removing the class reverts it to Plan). Different sections of the same course can still be planned to compare.

## 2026-07-21 — Distribution: static site on GitHub Pages 🚀
**LIVE: https://sahirssharma.github.io/WebReg-Course-Planner/** — shareable link, nothing to install.
- Converted to a browser-only build under `site/`: `scripts/export_static.py` bakes the FA26 catalog to `site/data/catalog.json` (2.8 MB), and `site/js/localdb.js` overrides `window.fetch` for `/api/*` so the existing `webreg.js` runs unchanged — client-side search + each visitor's schedule in their own browser (localStorage, key `webreg_fa26_schedule_v1`). No server, no shared-schedule clobbering.
- Deployed via a `gh-pages` branch (root); repo made public (Pages free tier). Repo canonical name is now **WebReg-Course-Planner**.
- Redeploy after a data/UI change: `python3 scripts/export_static.py` → copy `static/*` into `site/` if the app JS/CSS changed → push `site/` contents to the `gh-pages` branch.
- Caveat: seats/waitlists are a snapshot (baked at export). Refresh = re-run the TSS capture + import + export.

## 2026-07-21 — Finals: derive weekday for FA26 final rows
Audit confirmed final-exam dates are fully present (1,225 FA26 FI rows from TSS; 459 FA25) and already render in the results table FINAL row, the schedule list, and the Finals tab. One gap: TSS final rows store a bare date (`12/09/2026`) with no weekday prefix, so the weekday cell rendered blank. `finalWeekday()` now derives the weekday from the date when the prefix is missing (verified: 12/09/2026 → W, 12/05/2026 → Sa). Patched in both `static/js/webreg.js` and `site/js/webreg.js`; not yet redeployed to gh-pages (needs OK).
