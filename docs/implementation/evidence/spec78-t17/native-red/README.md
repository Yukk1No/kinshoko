# Native clipboard revocation RED

This is an actual product failure on Windows 11, before the final visibility commit permit.
`result.json` is an unmodified copy of `work/e2e/wall-capture-race-1791490083077/result.json`.
The matching frozen source/EXE manifest and byte-identical harnesses are included.
The EXE is retained at the absolute path in the manifest, outside Git.

The public production import receives a synthetic 10000×8000 PNG. Global mode is off,
the image is rated explicit, and a source grid is verified on the actual frozen screen.
An ordinary 8×8 capture seeds the real OS clipboard. Original-image copy starts and remains
pending when the public mode-on command returns at 20:08:42.061Z. At 20:08:42.263Z a direct
OS clipboard read still sees that 8×8 seed. At 20:08:46.359Z the same OS clipboard contains
1231×991 original pixels with the independently calculated source corner bytes.
The formal F3 clipboard action independently reads those same pixels.
`provedLateWrite: true` therefore includes the intermediate real seed observation;
it does not rely on a delayed JavaScript completion callback.

The final expected assertion fails. The original JSON/log/limited synthetic source and clipboard
PNGs remain unchanged. `native-release-before-fix.json` records the exact process/port release.
`settings-after-red.json` is a later actual observation after that release, with its SHA in
`copied-files.json`. It is not claimed as any earlier round's settings snapshot.
`root-desktop-release-check.json` independently records the initial test KnownFolder settings
as nonexistent at 19:36:09.2432262Z. The earlier package preflight reports 487 source and
10 distribution hashes matched; its grant-time harness differs from the later RED harness.

Earlier wall runs stopped at harness precondition/instrumentation problems. They remain in
ignored `work/e2e` and are partial runs, not a cumulative full pass or additional product RED.
