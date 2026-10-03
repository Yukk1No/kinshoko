---
version: 1
slug: "prototype-reference-workspace-src-app-tsx"
primary_target: "prototype/reference-workspace/src/App.tsx"
related_targets: ["prototype/reference-workspace/src/styles.css"]
---

# Reference workspace demo

Mode: Operate. Target: prototype/reference-workspace/src/App.tsx and its styles.

An artist finds an image in a library, takes a whole image or a crop, uses it beside drawing, and later reopens the saved reference group. Folder hierarchy and memberships organize sources; tags describe visible features; reference groups retain chosen views and their arrangement across libraries.

Preserve the existing icon rail, restrained theme, actual image colors, and virtual masonry. Build a separate throwaway app; preserve the old prototype's uncommitted edits. User explicitly requested a runnable demo instead of a static selection gate. The three alternatives are therefore directly interactive, with no claimed final selection or telemetry.

Structural candidates, ordered before implementation: (1) lookup wall with a working tray; (2) a project home leading to sources; (3) visual facets with a full-screen inspector; (4) adjacent source wall and reference board; (5) spatial boards as the entry point; (6) a focused find / take / use sequence; (7) collection inbox with deferred organization. Seed 5013281f dealt 6, 1, 4. These become A, B, C respectively. None introduces a new visual identity.

## Direction contract

THESIS: Every control advances finding and using a reference. Classification belongs to source images; the drawing workspace contains chosen views, with a separate saved-group home.

OWN-WORLD: Inherit DESIGN.md's neutral charcoal or pale gray surfaces, subdued olive active states, system UI type, consistent Lucide strokes, and quiet 180 ms state changes. The artist's images carry the color.

STORY: Start in a library, narrow by folders or features, inspect and take an image region, arrange references, save the group, and reopen it without reconstructing the selection.

FIRST VIEWPORT: A uses an icon rail, a collapsible source navigator, one search field with visible scope and selected conditions, and a dominant masonry wall. Its three-step switch moves between complete find, take, and use views. B keeps the lookup wall and a working tray; C puts the wall beside the reference board. On phones each exposes one main task at a time with reachable source and reference controls.

FORM: Focused sequence, candidate 6, leads the dealt comparison (seed 5013281f); candidates 1 and 4 remain equally runnable. The signature interaction is returning to the same lookup context after adding a crop, then reopening a group with its own layout intact.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries and hypotheses

Folder browsing includes descendants by default, with a direct-members switch. Multiple memberships reuse one source image. Text terms and selected tags intersect. These are trial rules, not new storage contracts. Existing artwork metadata is illustrative and manually authored. Local image selection is optional and stays in memory. The board simulates desktop reference windows in the web page; it does not prove native topmost, color management, backup, synchronization, or classifier accuracy. A reference group stores source references, crop and placement only. Reloading resets this throwaway demo.
