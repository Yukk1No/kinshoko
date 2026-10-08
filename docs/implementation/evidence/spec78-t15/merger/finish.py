import hashlib
import json
import pathlib
import re
import subprocess
from datetime import datetime, timezone

ROOT = pathlib.Path('C:/Users/yuk1no/.codex/worktrees/7dea/kinshoko')
OUT = ROOT / 'work/v1-handoff/follow-up-spec/merge17-checks'
MERGE = 'd93e7f803e160c73862a9692935471b072fc027a'
TIP = '2d6bb1a8cb78309173c4dfeceec0158bd02eb1c9'
WORKER = '2cdf025c4bed72e21178b64e22a501f562363f2c'

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()

def load(path):
    return json.loads((OUT / path).read_text(encoding='utf-8-sig'))

assert git('rev-parse', 'HEAD') == TIP
assert not git('status', '--porcelain=v1')
assert git('show', '-s', '--format=%P', TIP) == MERGE
assert git('rev-parse', MERGE + '^{tree}') == git('rev-parse', WORKER + '^{tree}')
audit = load('evidence-audit-postmerge.json')
doc = load('binding-doc-content-audit.json')
assert sorted(git('diff', '--name-only', MERGE, TIP).splitlines()) == sorted(doc['changedFiles'])
for row in doc['files']:
    data = (ROOT / row['file']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == row['sha256'] and len(data) == row['bytes']
doc['after'] = TIP
doc['afterTree'] = git('rev-parse', 'HEAD^{tree}')
doc['cleanAfterActualRegeneration'] = True
(OUT / 'binding-doc-content-audit.json').write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8')
checks = []
for name in ['core', 'ui', 'static', 'clippy', 'binding-doc', 'clippy-doc']:
    checks.extend(load(name + '-commands.json'))
failures = [row for row in checks if row['exitCode']]
assert len(failures) == 1 and failures[0]['name'] == 'diff-whitespace'
assert any(row['name'] == 'diff-whitespace-fixed' and row['exitCode'] == 0 for row in checks)
for filename in ['binding-doc-regeneration.txt', 'binding-doc-regeneration-fixed.txt']:
    content = (OUT / filename).read_text(encoding='utf-8-sig', errors='replace')
    assert 'library::types::export_bindings_importreport ... ok' in content
    assert 'test result: ok. 1 passed; 0 failed' in content

rust_log = (OUT / 'rust.txt').read_text(encoding='utf-8-sig', errors='replace')
rust_targets = []
for block in re.split(r'(?=\s+Running )', rust_log):
    if 'Running tests' not in block:
        continue
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\n]*', block)
    assert summaries
    parent = summaries[-1]
    assert int(parent[1]) == 0
    rust_targets.append({'target': block.splitlines()[0].strip(), 'passed': int(parent[0]),
                         'ignored': int(parent[2]), 'nestedSuccessfulSummaries': len(summaries) - 1})
assert len(rust_targets) == 6 and sum(row['passed'] for row in rust_targets) == 65
assert sum(row['ignored'] for row in rust_targets) == 3
ui_log = (OUT / 'ui.txt').read_text(encoding='utf-8-sig', errors='replace')
assert re.search(r'Test Files\s+5 passed', ui_log) and re.search(r'Tests\s+87 passed', ui_log)
native_dir = pathlib.Path(audit['nativeRuns'][-1]['path'])
same_screens = []
for a, b in [('current-library-reveiled.png', 'pending-current-library-no-revival.png'),
             ('default-sealed-prompt.png', 'pending-ui-close-no-revival.png')]:
    assert (native_dir / a).read_bytes() == (native_dir / b).read_bytes()
    same_screens.append({'first': a, 'second': b, 'byteIdentical': True})

report = {
    'status': 'passed', 'task': '#78 T15 / #94 independent merger',
    'completedAtUtc': datetime.now(timezone.utc).isoformat(),
    'integrationBefore': '1e8eb709eb0906f62ced84c4ccf203e6f3121c94',
    'workerTip': WORKER, 'workerTree': '79bb1657860296aa0d4be07bd155b63de2334dce',
    'mergeCommit': MERGE, 'mergeTree': git('rev-parse', MERGE + '^{tree}'),
    'parents': git('show', '-s', '--format=%P', MERGE).split(),
    'conflicts': [], 'mergeTreeEqualsWorker': True,
    'tip': TIP, 'tipTree': git('rev-parse', TIP + '^{tree}'),
    'postMergeDocumentationCommit': doc,
    'review': {
        'blockingFindings': [],
        'resolvedFindings': [{
            'file': 'src/bindings/ImportReport.ts', 'oldLines': [8, 12, 16],
            'finding': 'ts-rs emitted added trailing spaces at field-documentation boundaries.',
            'originalLog': 'diff-whitespace.txt', 'originalExitCode': 2,
            'resolution': 'Move report field notes to the Rust struct documentation and run the actual ts-rs export test. No field or field-order change; no manual generated-file editing.',
            'commit': TIP, 'fixedLog': 'diff-whitespace-fixed.txt', 'fixedExitCode': 0,
        }],
        'scope': [
            'Backend-owned fixed T10 receipt; ordinary progress/report privacy across all-known-provider Adult classification, including offline/out-of-scope providers.',
            'Unknown content remains visible. Mixed successful categories and completed totals are coarsened together; real failure paths remain available for retry.',
            'Explicit consent accepts actual task identity only. Opaque items are limited to live sealed duplicates on that actual completed receipt.',
            'Detached readonly provider reads one immutable original buffer, verifies its SHA, and uses the existing SDR path without mode, curation or derivative-cache mutation.',
            'Public prepare/resolve/complete boundaries and guarded chunk commits revoke on close, replacement consent, receipt dismissal, library context, source revision and mode/settings generation changes.',
            'Shared final visibility permit uses transition -> permit -> resource locks. Decode releases device/task locks first. The window-destruction callback only fences atomically and dispatches a worker; it does not wait for the permit.',
            'Each Channel publication is <=1023 bytes, under the locked Tauri 2.12.1 direct callback threshold; permit and resource locks end between chunks. Empty end marker is separately guarded.',
            'Frontend requires end marker and command acknowledgment, rejects partial/revoked transfer, disposes Blob URLs and binds consent to receipt plus current-library UI context while retaining the original task owner.',
            'Plugin handler names, build-time inline permissions, main capability and generated public TypeScript types agree.',
            'No new unsafe, production test-only IPC or mode-off exception. The rejected reader-mode proposal remained unexecuted; the readonly capability alternative is complete.',
        ],
        'sourceReferences': [
            'crates/kinshoko-core/src/workspace/import_preview.rs:80',
            'crates/kinshoko-core/src/workspace/import_preview.rs:159',
            'crates/kinshoko-core/src/workspace/import_preview.rs:318',
            'crates/kinshoko-core/src/workspace/import_preview.rs:345',
            'crates/kinshoko-core/src/library/mod.rs:337',
            'crates/kinshoko-core/src/device_libraries.rs:348',
            'src-tauri/src/library.rs:575',
            'src-tauri/src/library.rs:596',
            'src-tauri/src/library/import_preview.rs:98',
            'src-tauri/src/library/settings_backup.rs:59',
            'src/library/ImportMenu.tsx', 'src/library/ImportBar.tsx',
            'src/library/SealedImportPreview.tsx', 'src/ipc.ts:941',
        ],
        'separateT17Candidates': 'Ordinary capture-history pre-permit publication and provider/source mutation serialization remain T17/T20 review candidates. This merger neither claims them fixed nor treats unconfirmed static candidates as demonstrated T15 failures.',
        'notFinalStandardsSpecReview': True,
    },
    'checks': {
        'executed': checks,
        'independentCore': {'source': MERGE, 'targets': rust_targets, 'parentTestsPassed': 65,
            'ignoredChildEntrypoints': 3, 'nestedSuccessfulFaultChildRuns': 3,
            'nestedChildRunsAddedToParentTotal': False, 'log': 'rust.txt'},
        'independentUi': {'source': MERGE, 'files': 5, 'testsPassed': 87, 'log': 'ui.txt'},
        'postDoc': {'source': TIP, 'actualExportTestPassed': 1,
            'generatedOutputUnchangedBySecondExport': True, 'fmt': 'passed', 'typescript': 'passed',
            'fullDeltaWhitespace': 'passed', 'tauriAllTargetsStrictClippy': 'passed'},
        'workerArchivedFullUi': {'log': 'work/e2e/t15-current-library-all-ui.log',
            'files': 36, 'testsPassed': 279, 'rawBytesAndSummaryVerified': True,
            'reexecutedByMerger': False, 'sourceAttribution': 'Log does not itself embed a full Git SHA; fixed product/worker input provenance is separately audited. Independent merger rerun covers the 87 affected public UI tests at the exact clean merge SHA.'},
        'environment': {'target': str(ROOT / 'target'), 'cargoBuildJobs': 2,
            'temp': str(OUT / 'tmp'), 'workerTargetReused': False,
            'note': 'Workspace TEMP/TMP used from the first execution. Initial binding export emitted an incremental-cache hard-link warning and copied files instead; the export test succeeded. Raw warning preserved.'},
    },
    'evidence': {'auditBefore': 'evidence-audit-premerge.json', 'auditAfterMerge': 'evidence-audit-postmerge.json',
        'rawFilesChecked': audit['rawFilesChecked'], 'sourceFilesChecked': audit['sourceFilesChecked'],
        'distFilesChecked': audit['distFilesChecked'], 'sourceBeforeAfterIdentical': True,
        'sourceGitEolOnlyCount': len(audit['sourceGitEolOnly']),
        'rootVsWorkerEolOnlyCount': len(audit['rootVsWorkerEolOnly']),
        'rootArchive': audit['rootArchive'], 'native': audit['native'],
        'historicalNativeRuns': audit['nativeRuns'],
        'v2Status': 'frozen package never executed natively',
        'screenshots': {'inspected': ['default-sealed-prompt.png', 'explicit-receipt-preview.png',
            'closed-reveiled.png', 'current-library-reveiled.png'],
            'sameBytes': same_screens,
            'observation': 'Default and closed views contain the generic prompt, actual retry failure and no sealed image/name/success total. Explicit consent shows one synthetic noise image. Current-library change shows the original task receipt and no preview dialog. These are script/screenshot observations, not subjective hardware acceptance.'}},
    'limitations': audit['limits'] + [
        'Merger did not launch native apps, inspect or alter the currently reserved desktop, or mutate other worker trees.',
        'No push, GitHub operation, PR status change, Release publication or managed worktree cleanup performed.',
        'Final combined T20 native and full Standards/Spec review remain root-owned.',
        'Original #42/#71 bodies, status and evidence were not modified.',
        'The exact merge tree equals the worker. The subsequent tip differs only in two verified Rust/TypeScript documentation files; it is not the native product compilation source.',
    ],
    'rootWorkingTreeClean': True, 'released': True,
}
(OUT / 'result.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps({key: report[key] for key in ['status', 'mergeCommit', 'mergeTree', 'tip', 'tipTree', 'rootWorkingTreeClean', 'released']}, indent=2))
