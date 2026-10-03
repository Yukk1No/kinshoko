# Second reviewer-directed fix: verification

One correction batch, one successful `pnpm build` (includes TypeScript): 1,895 modules, 533ms, JS284.06kB/gzip89.42kB. Styles and Viewer/modal rules unchanged.

Independent CUA UI actions and later AX/DOM observations, 2026-10-03. No wheel scrolling or arbitrary delay. Exact observations: [interaction-round-2.json](interaction-round-2.json).

| Listed case | Observation |
| --- | --- |
| A1281×720,10000 records, End | Actual focus sample-10000; scroll601024.3125; card top339.46697998. |
| Enter → Return, same width | In a separate later read: identical scroll and card top; actual focus sample-10000. |
| Delete final card | 9999 records; actual focus sample-09999; scroll601024.3125; card top251.10848999. |
| No result → clear →390 wide | Logical focus/tab-stop sample-09999 retained; reflow remains near final records9989–9991. The removed clear button leaves BODY focus, so this case claims logical identity and viewport preservation, not actual toolbar/card focus. |
| A390 → B390, then Esc | Same scroll3599168.75; anchor sample-09990 relative gallery top194.71697998 in both layouts; actual focus sample-09999; all inert cleared. |
| B390,9999 records, click9990 → Esc | Before/after scroll3599311.75 and absolute card top360.12734985 identical; actual focus sample-09990;0inert. |
| B1281 desktop | Both gallery/viewer operable; card focus retained, no aria-modal,0inert. |
| B1281 →390 with detail open | Actual anchor sample-09979 retains relative top: -564.56604004 → -564.45285034 (0.11319 CSSpx rounding); viewer gets Return focus. Esc returns actual focus sample-09990 and clears inert. |
| B390 Tab | From final viewer button wraps to Return; aria-modal true and7 external inert surfaces. |

The source change replaces CSS height-string floating comparison with an explicit geometry commit revision. Builder reproduced original failure using installed TanStack: total601563.5092417246 serializes to601564; difference0.490758 exceeded0.1. The browser observations above establish behavior; the numeric reproduction explains the removed gate.

Nine screenshot filenames replaced together at the same sizes as the original review, all opened. A images at top; B/C detail open;100 records. No missing/black/half-loaded frame. Provenance scan is recorded separately. No second detector.

Scope remains only the original two material fixes. A/B/C have no production winner; no native Tauri, physical DPI/ICC/GPU or real large-library performance claims.
