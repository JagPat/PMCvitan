# Location navigation performance review

Date: 2026-09-05. Base: `2ec4ba7d7d5bb46573384ac9300cb6b14f41aafa`.

## Purpose and scope

The owner's request was to review PMCvitan and improve performance and efficiency.
Inspection covered snapshot composition, realtime refresh, portfolio aggregation,
web build output, and location navigation. This implementation is one focused
location-navigation unit: the Site Map cards and decision grouping share the same
tree helpers and exhibited measurable repeated work.

Vision alignment: site engineers and the PMC should navigate larger site records
quickly using the existing canonical locations. The change derives the same view
from the caller's authorized project slices and adds no data entry or approval path.
It is independent of the autonomous phase-6 consultation rollout; it does not
advance its task, clear its production directive, or claim deployment evidence.

## Reproduced findings and changes

1. **Decision grouping repeatedly scans the entire location register.** Each row
   calls `pathOf`, and room/object grouping walks its trail a second time. Flat
   and status modes perform these unused location lookups too. Build one ID
   index per location-grouping call, walk each trail once, and skip location
   work in flat/status modes. Standalone breadcrumb helpers retain their existing
   lookup path: allocating a full index for each shallow breadcrumb was measured
   and rejected during implementation.
2. **Every Site Map card rebuilds the tree and rescans all five record slices.**
   Build the adjacency map once, associate descendant locations with their cards,
   and scan each supplied record slice once. Memoize the result against the visible
   nodes, child cards, and record slices. No cache survives those inputs.
3. **Subtree construction copies growing sibling arrays, then recurses.** Append
   children to buckets and use an explicit stack. Preserve depth-first iteration
   order and cycle guards. A 20,000-level helper stress case that previously threw
   `RangeError` now completes; this is not a claim that all UI controls support
   rendering 20,000 nesting levels.

## Reproduce-first evidence

Before editing production code, native probes reproduced the old operation counts
and stack exhaustion. The two new performance test files were also run against
both production files restored from the base commit: **5/5 tests failed, exit 1**.
The failures were the intended assertions, not setup/import failures:

- room grouping: 1,005,000 location-ID reads exceeded the 10,000-read budget;
- flat and status grouping: the unused location lookup executed;
- subtree traversal: maximum call stack size exceeded;
- rendered Site Map: 6,400 photo-location reads exceeded the 320-read budget.

The same tests pass with the fix. The budgets count work, so their result does not
depend on CI wall-clock speed. Additional tests cover all five count categories,
overlapping roots, duplicate requested roots, cycles, missing parents, unfiled
records, moved nodes, empty/new scopes, and a filtered-out intermediate location.
Existing role visibility, draft, location context and capture tests remain green.

## Measurements

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
node scripts/benchmark-location-navigation.mjs 2ec4ba7d7d5bb46573384ac9300cb6b14f41aafa
```

The script compares the supplied git source with the working tree and asserts
equal outputs before reporting measurements. Node v24.19.0, median of seven
runs after two warmups:

| Synthetic workload | Base | Improved |
| --- | ---: | ---: |
| 1,000 locations / 1,000 decisions: location-ID reads | 1,005,000 | 3,000 |
| Same grouping: median helper time | 15.034 ms | 1.060 ms |
| 40 cards / 80 locations / 80 photos: photo-location reads | 6,400 | 80 |
| Same card counts: median helper time | 0.288 ms | 0.068 ms |

These are helper measurements on synthetic fixtures, not production page-load or
server-response measurements. Timings vary by machine. For valid sibling cards,
counting is linear in the tree and supplied records. Overlapping requested roots
or malformed cycles retain their original per-root counting semantics and may
require visiting a location for more than one card.

## Invariant matrix

| Invariant | Risk in this change | Verification |
| --- | --- | --- |
| authorization-tenancy | Cached counts could outlive the viewer/project slice. | Inputs remain the existing visible decision, published drawing/location and scoped record selectors; memo dependencies include every input; empty/moved/filtered-tree probes and existing visibility tests pass. |
| civil-time-lifecycle | Ordering or status grouping could change. | Existing group labels, fixed status order, counters and breadcrumbs match; no clock or lifecycle writes changed. |
| concurrency-idempotency | Memoization could retain counts after an update. | No shared mutable cache; all indexes are call-local; node-move and replacement-input probes pass; no requests, locks or writes changed. |
| data-integrity-conservation | Descendants or records could be double counted. | Tests assert exact counts for all five kinds, cycles, overlapping roots, missing parents and unfiled records; drawing cards still count filed descendants rather than inherited plans. |
| offline-reconciliation | Demo edits and fresh API snapshots must recompute identically. | Both use the same supplied arrays; tree updates and empty scope tests pass; write-ahead queues and reconciliation are untouched. |
| ui-server-parity | The faster view could widen its audience or alter its contents. | Existing permission selectors remain the call-site inputs; location/withdrawal/capture suites pass; no API, module boundary, schema, migration or server contract changed. |

## Validation and limits

- Focused location, performance, nested-location, withdrawal and capture suite:
  **99 tests passed** in seven files.
- `pnpm check`: **exit 0**, including **301 automation**, **994 web**, and
  **804 API** tests, web lint, web/API/shared type checks and production builds.
- Deterministic comparison over 100 additional generated graph fixtures matched
  base grouping, breadcrumb, ancestor, subtree-order and card-count results,
  including cycles and missing parents.
- No dependencies or deployed migration bytes changed.
- Local Chromium installation encountered CDN download timeouts; browser E2E
  is not claimed as passed. Required GitHub product, PostgreSQL/upgrade, browser,
  and independent current-head review gates remain required before merge.
- Claude is declared as correction owner for the existing repository workflow.
  The Claude Code web Auto-fix subscription cannot be verified from this session.

## Further profiling candidates

These are observations for separate focused work, not measured production defects:

- `useApiSync.refresh` starts the six-read Materials and ten-read Labour bundles
  on each realtime ping, alongside Commercial and open claim/register reads.
  Their latest-request tokens discard stale replies but do not bound outstanding
  requests. Profile a representative event burst before introducing bounded
  refresh with a guaranteed trailing read; simply dropping in-flight pings could
  miss a committed update or prematurely release a pending action.
- The web build emits an approximately **832 kB minified / 225 kB gzip** main JS
  chunk. Measure initial mobile load and assess route splitting together with
  offline navigation and stale-deployment chunk recovery in a separate unit.
