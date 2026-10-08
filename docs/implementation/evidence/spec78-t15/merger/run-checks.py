import json
import os
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = pathlib.Path('C:/Users/yuk1no/.codex/worktrees/7dea/kinshoko')
OUT = ROOT / 'work/v1-handoff/follow-up-spec/merge17-checks'
environment = os.environ.copy()
environment['CARGO_BUILD_JOBS'] = '2'
environment['CARGO_TARGET_DIR'] = str(ROOT / 'target')
environment['TEMP'] = environment['TMP'] = str(OUT / 'tmp')
environment['GIT_OPTIONAL_LOCKS'] = '0'
(OUT / 'tmp').mkdir(exist_ok=True)
sets = {
    'core': [('rust', ['cargo', 'test', '-p', 'kinshoko-core', '--locked',
        '--test', 'import_preview', '--test', 'workspace', '--test', 'save_destination',
        '--test', 'safe_mode', '--test', 'eagle_deleted_content',
        '--test', 'application_settings_backup'])],
    'clippy': [('clippy', ['cargo', 'clippy', '-p', 'kinshoko', '--all-targets', '--locked', '--', '-D', 'warnings'])],
    'binding-doc': [
        ('binding-doc-regeneration-fixed', ['cargo', 'test', '-p', 'kinshoko-core', '--lib', '--locked', 'export_bindings_importreport']),
        ('fmt-after-binding-doc', ['cargo', 'fmt', '--all', '--', '--check']),
        ('typescript-after-binding-doc', ['npm.cmd', 'run', 'typecheck']),
        ('diff-whitespace-fixed', ['git', 'diff', '--check', '1e8eb709eb0906f62ced84c4ccf203e6f3121c94', 'HEAD']),
    ],
    'clippy-doc': [('clippy-after-binding-doc', ['cargo', 'clippy', '-p', 'kinshoko', '--all-targets', '--locked', '--', '-D', 'warnings'])],
    'ui': [('ui', ['npx.cmd', 'vitest', 'run', 'src/library/ImportMenu.test.tsx',
        'src/library/ImportBar.test.tsx', 'src/import-preview-ipc.test.ts',
        'src/App.test.tsx', 'src/SettingsPanel.test.tsx'])],
    'static': [
        ('fmt', ['cargo', 'fmt', '--all', '--', '--check']),
        ('typescript', ['npm.cmd', 'run', 'typecheck']),
        ('harness-syntax', ['node', '--check', 'e2e/sealed-import-preview.mjs']),
        ('helper-syntax', ['node', '--check', 'scripts/check-sealed-preview-revocation.mjs']),
        ('diff-whitespace', ['git', 'diff', '--check', '1e8eb709eb0906f62ced84c4ccf203e6f3121c94', 'HEAD']),
    ],
}
mode = sys.argv[1]
reports = []
for name, command in sets[mode]:
    started = datetime.now(timezone.utc).isoformat()
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, env=environment).decode().strip()
    tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, env=environment).decode().strip()
    tick = time.monotonic()
    with (OUT / (name + '.txt')).open('wb') as log:
        p = subprocess.run(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
    entry = {'name': name, 'command': command, 'exitCode': p.returncode,
        'startedAtUtc': started, 'finishedAtUtc': datetime.now(timezone.utc).isoformat(),
        'durationSeconds': time.monotonic() - tick, 'source': source, 'tree': tree,
        'log': name + '.txt', 'target': environment['CARGO_TARGET_DIR'],
        'cargoBuildJobs': '2', 'temp': environment['TEMP']}
    reports.append(entry)
    (OUT / (mode + '-commands.json')).write_text(json.dumps(reports, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(entry), flush=True)
    if p.returncode:
        print((OUT / (name + '.txt')).read_text(encoding='utf-8-sig', errors='replace')[-7000:], flush=True)
        sys.exit(p.returncode)
