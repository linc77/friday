# Client rendering boundaries

Interactive performance is a property of the update path, not of the number of
retained pages. A retained page must still display current data and stop its
view-scoped work when detached.

## State ownership

- `FridayStore` uses Observation. Views observe the properties they actually
  read; do not restore an object-wide publisher to make a missing dependency work.
- Overview summaries and task bodies are different subscriptions. Detail reads
  observe a task ID through `TaskObservation`; a detail stream does not publish
  the overview array or invalidate another task. Summary patches invalidate their
  changed/removed IDs. Authoritative snapshots invalidate all registered IDs.
- Stream cursors, leases and derived indexes are not UI state. They must not
  become observed dependencies merely because a getter uses them.
- Connecting an already running connection is idempotent. Explicit reconnect
  uses `force: true`; activating a window does not tear down healthy streams.
- Persisted UI preferences use `FridayPreference`, whose entries publish only
  changes to their own effective value. In a foreground resize trace, unrelated
  `AppStorage` properties (root appearance/language and sidebar grouping) were
  marked changed when the panel width was saved. Do not use a store-wide defaults
  notification as a view dependency. The shared preference store reconciles legacy
  direct writes, preserves existing keys/formats, and weakly holds subscriptions
  so closing a page releases its state. A live entry owns its store.

## Interaction and presentation

- Native module, task and split containers explicitly accept the parent's size
  proposal through `sizeThatFits`. Their documents do not determine the viewport's
  size. Falling back to AppKit's intrinsic fitting traverses the nested hosting
  tree and solves its constraints during pointer movement.
- `TranscriptViewport` observes only height and safe-area inset as content data.
  Horizontal resizing reflows the existing message graph; it does not regenerate
  the ScrollView content closure through a full-width `GeometryReader`.
- `TaskPanelSplitHost` owns live divider motion. Pointer movement changes native
  frames. Mouse-up and accessibility adjustments commit the width once. The parent
  then persists it through the existing panel-preference path. Cancellation does
  not commit. Geometry changes must not recreate either hosting view.
- History materialization and timeline derivation use explicit data revisions
  (`TaskTranscriptProjection`), including host/task scope and paged history.
  A dedicated actor prepares immutable presentations off the main thread. A running
  calculation may complete while the pending slot coalesces to the latest input,
  preventing starvation during fast streams. Leaving the page, removal or a scope
  change cancels work; results from an old scope cannot be published.
  A layout, composer or focus change cannot sort the same history again. Data
  changes, removals and host changes must invalidate the presentation. Formatter
  instances used by projection are thread-local, never shared with UI labels.
- Scroll samples and the current visible anchor belong to `TranscriptScrollTracking`,
  not the whole page's SwiftUI state. Only semantic following/end/collapse changes
  update the page. Modern scroll geometry APIs do not also emit legacy preferences.
- Native text updates distinguish content, annotations, selection and geometry.
  Empty annotation layers do not scan or invalidate the source document. Paired
  diff spacing still builds the line index when it is actually required.
- Re-registering an unchanged citation part does not rebuild or repaint the
  message's selection graph. Replacement parts and changed UTF-16 text do.

## Reference implementations

The design was compared with the local T3 Code checkout at `a9e709f1` and Paseo
at `d924954`; it does not assume either application is universally hitch-free.

- T3: `apps/web/src/hooks/useResizableWidth.ts` separates live DOM width from
  the committed React state/storage; `useIncrementalTimelineEntries.ts` derives
  timeline entries only when source inputs change. `MessagesTimeline.tsx` uses
  a list component that controls item mounting.
- Paseo: `packages/app/src/panels/agent-panel.tsx` selects per-agent state;
  `components/resize-handle-drag.ts` separates preview and commit;
  `agent-stream/web-virtualization.ts` bounds mounted history.

## Verification

Run the affected native tests, not the full repository suite. `FridayRenderingTests`
checks cross-task invalidation, current data after removal, revision-scoped
projection, 120 continuous resize updates with one commit, and empty annotations
over a 10,000-line document. Existing stream/history, citation, diff and retained
page tests cover the surrounding correctness contracts.
`FridayPreferenceTests` verifies unrelated and equal writes, direct writes and
removal, isolated defaults domains, storage formats, subscription lifetime, and
the actual body update count of a mounted SwiftUI view.

Use `pnpm mac:build -- --optimized` for performance acceptance with the workspace
app identity and shared development service preserved. It enables Release
optimization without packaging a standalone release. Compare the same tasks,
window size and interaction in each build. Navigation layout timings, command
latency and CPU samples are not frame-rate measurements; frame hitches require
a continuous foreground trace. Discard traces where the window was hidden or
relegated to a Stage Manager thumbnail.

Launch with `FRIDAY_PERFORMANCE=1 pnpm mac:open` for payload-free navigation and
resize counters. `FRIDAY_PERFORMANCE=changes` additionally enables SwiftUI
dependency-change logs for root, sidebar, task detail and composer. These logs
identify invalidation sources; disable the verbose mode for timing comparisons.
