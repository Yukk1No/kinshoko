# First reviewer-directed fix: verification

Source: `prototype/library-browser/src/App.tsx`, `Masonry.tsx`, `Viewer.tsx`; uncommitted prototype on 2026-10-03.

Build passed after one batched correction: TypeScript and Vite production build.

## Finding 1: return and focus
- Stable test without wheel inertia, A, 1281×720, 9,999 synthetic records after removing sample-10000.
- Click sample-09999; baseline scrollTop 601024.3125, card top 251.10848999, focus sample-09999.
- Enter opens viewer and focuses Return. Click Return, then a separate AX/DOM observation: same scrollTop and card top, **focus BODY**.
- Earlier End/Delete in the same data scale left focus BODY at scrollTop 601024.3125. This is still a failure of the listed focus/restore contract.
- A preceding wheel-based measurement changed 918.34→960; not authoritative because the wheel could still be in motion.
- Cross-layout A→narrow B closed with focus BODY and scroll0. Treat preservation across geometry changes as unresolved. No invented exact runtime cause.

## Finding 2: narrow B
- 390×844, 100 records, click sample-00001: visible viewer gains focus on Return; aria-modal true; gallery and external controls inert.
- Tab from last viewer control wraps to Return.
- Esc closes viewer, removes inert, returns focus to sample-00001 at scroll0.
- 1440×900 desktop B: aria-modal absent, inert count0; gallery card remains focused and both sides remain operable.
- At 9,999 records the shared restore failure from Finding1 also affects closing B. Score this relationship honestly; do not claim the large-data case passed.

## Capture matrix
Same nine filenames replaced in one batch; all opened and visually checked. 100-record fixtures at top for A captures; B/C detail open. No black/blank/half-loaded frame. Screenshot sizes remain A1440×900, A390×844, B/C1440×900, B/C390×844, viewer1440×900, user1281×720 and user1044×1053.

Scope: verdict pass over the original two material findings only. Do not reopen a whole-surface critique. No second detector.
