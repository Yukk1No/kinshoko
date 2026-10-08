import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path('C:/Users/yuk1no/.codex/worktrees/7dea/kinshoko')
WORKER = pathlib.Path('C:/Users/yuk1no/.codex/worktrees/spec78-t01-frontend/kinshoko')
OUT = ROOT / 'work/v1-handoff/follow-up-spec/merge17-checks'
BEFORE = '1e8eb709eb0906f62ced84c4ccf203e6f3121c94'
FINAL = '2cdf025c4bed72e21178b64e22a501f562363f2c'
FINAL_TREE = '79bb1657860296aa0d4be07bd155b63de2334dce'
PRODUCT = '473bdb1dc4802577d805534c17b4201a01a38aa8'
PRODUCT_TREE = 'e4a0caf90bf8c5e789df485d5385f2b1e37456fb'
HARNESS = '364cdac297bb8b8b1eac3541033edf1caf503a77'
environment = os.environ.copy()
environment['GIT_OPTIONAL_LOCKS'] = '0'

def git(cwd, *args):
    p = subprocess.run(['git', *args], cwd=cwd, env=environment, capture_output=True)
    if p.returncode:
        raise RuntimeError(f'git {args}: {p.returncode}: {p.stderr.decode(errors="replace")}')
    return p.stdout.decode('utf-8').strip()

def load(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check_file(path, expected, size=None):
    p = pathlib.Path(path)
    data = p.read_bytes()
    assert sha(data) == expected, f'SHA mismatch: {p}'
    if size is not None:
        assert len(data) == size, f'Size mismatch: {p}'
    return data

def hash_rows(rows, relative_to=None):
    for row in rows:
        p = pathlib.Path(row.get('path', row.get('file')))
        if relative_to is not None:
            p = relative_to / p
        check_file(p, row['sha256'], row.get('bytes'))
    return len(rows)

def blobs(ref):
    result = {}
    for row in git(WORKER, 'ls-tree', '-r', ref).splitlines():
        metadata, name = row.split('\t', 1)
        result[name] = metadata.split()[2]
    return result

def read_git_blobs(ids):
    p = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=WORKER, env=environment,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    data = {}
    for oid in set(ids):
        p.stdin.write((oid + '\n').encode())
        p.stdin.flush()
        header = p.stdout.readline().decode().split()
        assert header[0] == oid and header[1] == 'blob', header
        data[oid] = p.stdout.read(int(header[2]))
        assert p.stdout.read(1) == b'\n'
    p.stdin.close()
    assert p.wait() == 0, p.stderr.read().decode(errors='replace')
    return data

stage = sys.argv[1] if len(sys.argv) > 1 else 'premerge'
OUT.mkdir(parents=True, exist_ok=True)
root_head = git(ROOT, 'rev-parse', 'HEAD')
root_status = git(ROOT, 'status', '--porcelain=v1')
assert git(ROOT, 'branch', '--show-current') == 'codex/spec-78-integration'
assert not root_status, root_status
if stage == 'premerge':
    assert root_head == BEFORE, root_head
else:
    assert git(ROOT, 'rev-parse', 'HEAD^{tree}') == FINAL_TREE
    assert git(ROOT, 'show', '-s', '--format=%P', 'HEAD').split() == [BEFORE, FINAL]
assert git(WORKER, 'branch', '--show-current') == 'codex/spec-78-t15'
assert git(WORKER, 'rev-parse', 'HEAD') == FINAL
assert git(WORKER, 'rev-parse', 'HEAD^{tree}') == FINAL_TREE
assert not git(WORKER, 'status', '--porcelain=v1')
git(WORKER, 'merge-base', '--is-ancestor', BEFORE, FINAL)
assert git(WORKER, 'rev-parse', PRODUCT + '^{tree}') == PRODUCT_TREE

index = load(WORKER / 'work/e2e/t15-evidence-index-final.json')
assert index['finalSource'] == FINAL and index['finalTree'] == FINAL_TREE and index['clean']
assert index['productSource'] == PRODUCT and index['productTree'] == PRODUCT_TREE
raw_count = hash_rows(index['rawFiles'])
run_counts = []
for run in index['nativeRuns']:
    count = hash_rows(run['files'])
    actual = load(pathlib.Path(run['path']) / 'result.json')
    assert actual['status'] == run['status']
    assert len(actual['assertions']) == run['assertions']
    run_counts.append({'path': run['path'], 'files': count, 'status': actual['status'],
                       'assertions': len(actual['assertions'])})
fixture_counts = []
for fixture in index['fixtures']:
    manifest = fixture['manifest']
    check_file(manifest['path'], manifest['sha256'], manifest['bytes'])
    fixture_counts.append({'directory': fixture['directory'], 'files': hash_rows(fixture['files'])})
for row in [index['binary'], index['manifest'], index['harness'], index['document'], *index['helper']]:
    check_file(row['path'], row['sha256'], row.get('bytes'))

manifest = load(index['manifest']['path'])
before_build = load(WORKER / 'work/e2e/t15-source-before-build-v3.json')
assert manifest['source'] == PRODUCT and manifest['tree'] == PRODUCT_TREE
assert not manifest['worktreeStatus']
assert manifest['sourceFiles'] == before_build['sourceFiles']
assert manifest['config'] == before_build['config']
source_count = hash_rows(manifest['sourceFiles'], WORKER)
dist_count = hash_rows(manifest['distFiles'], WORKER)
assert source_count == 556 and dist_count == 10
check_file(manifest['binaryPath'], manifest['binarySha256'])
check_file(manifest['config']['file'], manifest['config']['sha256'])
check_file(manifest['fixture']['path'], manifest['fixture']['sha256'])
transport = manifest['previewTransport']
check_file(transport['implementation'], transport['implementationSha256'])
assert transport['chunkMaximumBytes'] == 1023 and transport['rawDirectThresholdExclusive'] == 1024
trees = {ref: blobs(ref) for ref in [PRODUCT, FINAL, HARNESS]}
all_blobs = read_git_blobs(row['gitBlob'] for row in manifest['sourceFiles'])
source_eol_only, root_eol_only = [], []
for row in manifest['sourceFiles']:
    name, oid = row['file'], row['gitBlob']
    assert trees[PRODUCT][name] == oid and trees[FINAL][name] == oid
    raw = (WORKER / name).read_bytes()
    blob = all_blobs[oid]
    if raw != blob:
        assert raw.replace(b'\r\n', b'\n') == blob.replace(b'\r\n', b'\n'), name
        source_eol_only.append(name)
    if stage != 'premerge':
        local = (ROOT / name).read_bytes()
        if local != raw:
            assert local.replace(b'\r\n', b'\n') == raw.replace(b'\r\n', b'\n'), name
            root_eol_only.append(name)
delta_after_build = git(WORKER, 'diff', '--name-only', PRODUCT, FINAL).splitlines()
assert sorted(delta_after_build) == ['docs/implementation/spec-78-t15.md', 'e2e/sealed-import-preview.mjs']
assert manifest['harness']['source'] == HARNESS
assert git(WORKER, 'rev-parse', HARNESS + '^{tree}') == manifest['harness']['tree']
for item in [manifest['harness'], *manifest['harnessDependencies']]:
    path = pathlib.Path(item['path'])
    check_file(path, item['sha256'])
    rel = path.relative_to(WORKER).as_posix()
    assert trees[HARNESS][rel] == trees[FINAL][rel]

archive_path = ROOT / 'work/v1-handoff/follow-up-spec/evidence/t15-native/root-preservation-v3-final.json'
archive = load(archive_path)
assert archive['files'] == len(archive['entries']) == 51
assert archive['bytes'] == sum(row['bytes'] for row in archive['entries']) == 81416509
for row in archive['entries']:
    check_file(row['source'], row['sha256'], row['bytes'])
    check_file(archive_path.parent / row['file'], row['sha256'], row['bytes'])

final_run = load(WORKER / 'work/e2e/t15-native-run-v3-retry1/result.json')
assert final_run['status'] == 'passed' and len(final_run['assertions']) == 43
assert len(final_run['safeStates']) == 7 and all(row['on'] for row in final_run['safeStates'])
assert final_run['manifestSha256'] == index['manifest']['sha256']
assert final_run['harnessSha256'] == index['harness']['sha256']
for row in final_run['harnessSources']:
    check_file(row['source'], row['sha256'], row['bytes'])
    check_file(row['preserved'], row['sha256'], row['bytes'])
chunk_races = [row for row in final_run['races'] if row['afterFirstChunk']]
assert len(chunk_races) == 2
for row in chunk_races:
    assert row['failure'] and row['completionMarkerAt'] is None
    assert row['bytesAfterActionResponse'] == row['chunksAfterActionResponse'] == 0
    assert 0 < row['length'] < final_run['largeOriginal']['bytes']
    assert row['firstChunkAt'] <= row['actionStartedAt'] <= row['actionEndedAt']
    assert row['maximumChunkBytes'] <= 1023
native_summary = {'source': PRODUCT, 'tree': PRODUCT_TREE, 'binarySha256': manifest['binarySha256'],
    'harnessSource': HARNESS, 'harnessSha256': final_run['harnessSha256'],
    'status': final_run['status'], 'assertions': len(final_run['assertions']),
    'safeStatesOn': len(final_run['safeStates']),
    'chunkRaces': [{key: row[key] for key in ['action', 'actionElapsedMs', 'length', 'chunks',
        'bytesAfterActionResponse', 'chunksAfterActionResponse', 'completionMarkerAt']} for row in chunk_races],
    'reexecuted': False}
raw_summaries = {}
for name in ['t15-stream-regression.log', 't15-stream-final-core.log',
             't15-stream-final-clippy.log', 't15-current-library-all-ui.log',
             't15-current-library-types.log']:
    log = (WORKER / 'work/e2e' / name).read_text(encoding='utf-8-sig', errors='replace')
    raw_summaries[name] = {'rustSummaries': re.findall(r'test result:.*', log),
                            'tail': log.splitlines()[-14:]}

report = {'status': 'passed', 'stage': stage, 'observedAtUtc': datetime.now(timezone.utc).isoformat(),
    'integrationHead': root_head, 'integrationTree': git(ROOT, 'rev-parse', 'HEAD^{tree}'),
    'integrationClean': not root_status, 'workerTip': FINAL, 'workerTree': FINAL_TREE,
    'workerClean': True, 'rawFilesChecked': raw_count, 'nativeRuns': run_counts,
    'fixtureFiles': fixture_counts, 'native': native_summary,
    'sourceFilesChecked': source_count, 'distFilesChecked': dist_count,
    'sourceBeforeAfterIdentical': True, 'productSourceBlobsIdenticalToFinal': True,
    'sourceGitEolOnly': source_eol_only, 'rootVsWorkerEolOnly': root_eol_only,
    'postBuildChangedFiles': delta_after_build,
    'rootArchive': {'index': str(archive_path), 'files': archive['files'], 'bytes': archive['bytes'],
                    'allSourceAndCopyHashesMatch': True},
    'archivedLogSummaries': raw_summaries,
    'limits': index['limits'], 'nativeProgramsLaunched': False, 'rawFilesRewritten': False}
(OUT / f'evidence-audit-{stage}.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['archivedLogSummaries', 'sourceGitEolOnly', 'rootVsWorkerEolOnly']}, indent=2, ensure_ascii=True))
