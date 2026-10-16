import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainStandaloneOwnership} from './native-standalone-guard.mjs';

const owned={pid:42,parentPid:41,created:'2026-10-16T03:52:38.742342Z',executable:'C:/test-runtime/msedgewebview2.exe',descendant:true};
const detached={...owned,descendant:false};

test('an already verified child remains owned after its parent has exited',()=>{
  const result=retainStandaloneOwnership([detached],[owned]);
  assert.equal(result[0].descendant,true);
  assert.equal(detached.descendant,false);
});
test('a transiently unavailable current path retains the previous exact identity proof',()=>{
  const result=retainStandaloneOwnership([{...detached,executable:null}],[owned]);
  assert.equal(result[0].descendant,true);
  assert.equal(result[0].executable,null);
  assert.equal(result[0].previouslyVerified.executable,owned.executable);
});
test('a reused PID with a different creation time stays unowned',()=>{
  assert.equal(retainStandaloneOwnership([{...detached,created:'2026-10-16T04:00:00.000000Z'}],[owned])[0].descendant,false);
});
test('a conflicting current executable stays unowned',()=>{
  assert.equal(retainStandaloneOwnership([{...detached,executable:'C:/other-runtime/msedgewebview2.exe'}],[owned])[0].descendant,false);
});
test('a new unknown process cannot gain ownership from an unavailable path',()=>{
  assert.equal(retainStandaloneOwnership([{...detached,pid:99,executable:null}],[owned])[0].descendant,false);
});
test('an earlier unowned observation cannot authorize a later observation',()=>{
  assert.equal(retainStandaloneOwnership([detached],[{...owned,descendant:false}])[0].descendant,false);
});
