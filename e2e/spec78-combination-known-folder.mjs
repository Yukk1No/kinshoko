// KnownFolder settings snapshot and restore for the T20 combined native workflow, moved verbatim from spec78-combination-preflight.mjs (commit size limit).
// spec78-combination-preflight.mjs re-exports everything exported here.
import { writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { sha256 } from "./spec78-combination-fixture.mjs";
import { IDENTIFIER, python, ownedWork, fileRecord, knownFolderState, knownUnchanged } from "./spec78-combination-preflight.mjs";

export function preserveKnownFolder(work, stem = "settings-before") {
  ownedWork(work);
  const before = knownFolderState();
  const saved = python("import pathlib,json,sys,shutil\ns=json.loads(sys.argv[1]); root=pathlib.Path(sys.argv[2]); result=[]\nfor key in ['requested','resolved']:\n item=s[key]; p=pathlib.Path(item['path']); target=root/(sys.argv[3]+'-'+key+'.json')\n if p.is_file(): shutil.copyfile(p,target)\n result.append({'view':key,'original':str(p),'backup':str(target) if p.is_file() else None,**item})\nprint(json.dumps(result))", [JSON.stringify(before), resolve(work), stem]);
  const snapshot = { ...before, saved };
  writeFileSync(join(work, stem + "-metadata.json"), JSON.stringify(snapshot, null, 2));
  return snapshot;
}
export function restoreKnownFolder(snapshot, work) {
  ownedWork(work);
  if (snapshot.identifier !== IDENTIFIER) throw Error("Only the T20 test settings may be restored");
  for (const view of snapshot.saved) if (!view.original.toLowerCase().endsWith((sep + IDENTIFIER + sep + "settings.json").toLowerCase())) throw Error("Unexpected settings path");
  for(const view of snapshot.saved)if(view.backup){const backup=fileRecord(view.backup);if(backup.sha256!==view.sha256||backup.bytes!==view.bytes)throw Error("Preserved before settings bytes changed");}
  const current = knownFolderState();
  if(current.requested.path.toLowerCase()!==snapshot.requested.path.toLowerCase())throw Error("KnownFolder requested identity changed during this round");
  for(const view of [current.requested,current.resolved])if(!view.path.toLowerCase().endsWith((sep+IDENTIFIER+sep+"settings.json").toLowerCase()))throw Error("Unexpected current test settings alias");
  python("import pathlib,json,sys,shutil\ns=json.loads(sys.argv[1]); current=json.loads(sys.argv[3]); root=pathlib.Path(sys.argv[2])\nfor key in ['requested','resolved']:\n p=pathlib.Path(current[key]['path'])\n if p.is_file(): shutil.copyfile(p,root/('settings-after-'+key+'.json'))\n# Existing alias bytes must agree before any restoration mutation.\nif s['requested']['exists']!=s['resolved']['exists'] or s['requested']['sha256']!=s['resolved']['sha256']: raise RuntimeError('Ambiguous before settings alias; preserve current files for root inspection')\nif current['requested']['exists']!=current['resolved']['exists'] or current['requested']['sha256']!=current['resolved']['sha256']: raise RuntimeError('Ambiguous current settings alias; preserve current files for root inspection')\nfor item in s['saved']:\n p=pathlib.Path(item['original'])\n if item['backup']:\n  p.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(item['backup'],p)\n elif p.is_file(): p.unlink()\nprint(json.dumps({'restored':True}))",[JSON.stringify(snapshot),resolve(work),JSON.stringify(current)]);
  const after=knownFolderState(),initiallyAbsent=!snapshot.requested.exists&&!snapshot.resolved.exists;
  // Windows package redirection may become resolvable only after the test directory is created.
  // Freeze/plan checks stay strict. Restoration of an initially absent file permits that mapping
  // change only after both actual views are again absent; no parent directory is removed.
  if(initiallyAbsent) {
    if(after.requested.path.toLowerCase()!==snapshot.requested.path.toLowerCase()||after.requested.exists||after.resolved.exists)throw Error("Previously absent test settings were not removed from both actual aliases");
    if(!after.resolved.path.toLowerCase().endsWith((sep+IDENTIFIER+sep+"settings.json").toLowerCase()))throw Error("Unexpected restored test settings alias");
  } else knownUnchanged(snapshot,after);
  const report={before:snapshot,during:current,after,restored:true,initiallyAbsent,resolutionChanged:snapshot.resolved.path.toLowerCase()!==after.resolved.path.toLowerCase()};
  writeFileSync(join(work, "settings-restoration.json"), JSON.stringify(report, null, 2));
  return report;
}

export function clearKnownFolderForBlank(work) {
  const before=preserveKnownFolder(work,"configured-settings-before-blank");
  python("import pathlib,json,sys\ns=json.loads(sys.argv[1]); removed=[]\nfor item in s['saved']:\n p=pathlib.Path(item['original'])\n if p.is_file(): p.unlink(); removed.append(str(p))\nprint(json.dumps({'removed':removed}))",[JSON.stringify(before)]);
  const after=knownFolderState();
  if(after.requested.exists||after.resolved.exists)throw Error("Blank test settings still exist at a KnownFolder alias");
  const receipt={before,after,scope:"exact T20 test settings only; original pre-run snapshot remains protected"};
  writeFileSync(join(work,"blank-known-folder-boundary.json"),JSON.stringify(receipt,null,2));return receipt;
}
