from pathlib import Path
import subprocess,json,hashlib,sys,datetime
root=Path.cwd()
inputs=['.cargo','crates','data','public','scripts','src-tauri','src','tools','Cargo.toml','Cargo.lock','rust-toolchain.toml','index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts']
def git(*args): return subprocess.check_output(['git',*args],text=True).strip()
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
files=[]
for row in subprocess.check_output(['git','ls-files','-s','-z']).decode().split('\0'):
    if not row: continue
    meta,name=row.split('\t',1)
    if not any(name==x or name.startswith(x+'/') for x in inputs): continue
    path=root/name
    files.append({'file':name,'gitBlob':meta.split()[1],'bytes':path.stat().st_size,'sha256':digest(path)})
dist=[{'file':str(p.relative_to(root)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted((root/'dist').rglob('*')) if p.is_file()]
result={'collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'collectionStage':sys.argv[1],'source':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'worktreeStatus':git('status','--porcelain'),'productInputs':inputs,'sourceFiles':files,'distFiles':dist}
config=root/'work/e2e/t12-tauri-config.json'
result['config']={'file':str(config),'sha256':digest(config),'value':json.loads(config.read_text(encoding='utf-8-sig'))}
Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'source':result['source'],'tree':result['tree'],'sourceFiles':len(files),'distFiles':len(dist),'clean':not result['worktreeStatus']}))
