// T20 synthetic input construction. No app, browser, native window or system setting is touched.
// Released v16 SQL constructs old input only; product assertions use public commands and rendered UI.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function png(path, width, height, channels, pixel) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const stride = 1 + width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const values = pixel(x, y);
    for (let c = 0; c < channels; c++) rows[y * stride + 1 + x * channels + c] = values[c];
  }
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(path, bytes);
  return { path, width, height, sha256: sha256(bytes), bytes: bytes.length };
}
function entropy(seed) {
  let value = seed >>> 0;
  return () => {
    const next = () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value & 255; };
    return [next(), next(), next()];
  };
}
export function createCombinationFixture(output) {
  const root = resolve(output);
  const owned = resolve("work/e2e");
  if (!root.startsWith(owned + sep) || !root.includes("spec78-t20")) throw Error("Fixture must be inside this tree's owned T20 work/e2e directory");
  if (existsSync(root)) throw Error("Fixture output already exists; preserve it and choose a new round");
  mkdirSync(root, { recursive: true });
  const inputs = join(root, "inputs"); mkdirSync(inputs);
  const libraries = join(root, "libraries", "共同长前缀用于核对资料库来源与独立保存目标"); mkdirSync(libraries, {recursive:true});
  const old = png(join(inputs,"legacy.png"), 3, 3, 3, () => [18,28,38]);
  const visible = png(join(inputs,"visible-position-alpha.png"), 3200, 2400, 4, (x,y) => [(13*x+29*y)&255, ((x>>>3)^(y*17))&255, (x*7+y*19)&255, (x+y)%17===0?128:255]);
  const sealed = png(join(inputs,"sealed-entropy.png"), 2400, 1800, 3, entropy(0x780020));
  const unknown = png(join(inputs,"unknown-control.png"), 800, 600, 3, (x,y) => [120+(x/25|0),30+(y/20|0),120]);
  const incoming = png(join(inputs,"incoming-owner.png"), 1024, 768, 3, entropy(0x780021));
  const virtual = Array.from({length:144},(_,i)=>png(join(inputs,`virtual-${String(i).padStart(3,"0")}.png`),420,280,3,(x,y)=>[(i*17+(x/14|0))&255,(60+(y/14|0))&255,(90+i*31)&255]));
  // Reuse T14's exact Eagle fixture shape and pixel recipe without importing its app-running script.
  const eagleFirst=png(join(inputs,"eagle-v1.png"),240,180,3,(x,y)=>[80,x*7%256,y*9%256]);
  const eagleNew=png(join(inputs,"eagle-v2.png"),310,130,3,(x,y)=>[180,x*7%256,y*9%256]);
  const sourceParent=join(root,"eagle-selected-parent"),eagleRoot=join(sourceParent,"Eagle.library");
  const itemId="ITEM000000000",item=join(eagleRoot,"images",itemId+".info");mkdirSync(item,{recursive:true});
  const original=join(item,"test.png"),itemMetadata=join(item,"metadata.json"),libraryMetadata=join(eagleRoot,"metadata.json");
  writeFileSync(original,readFileSync(eagleFirst.path));
  writeFileSync(itemMetadata,JSON.stringify({id:itemId,name:"test",ext:"png",size:eagleFirst.bytes,width:240,height:180,tags:["Eagle 标签"],folders:[],annotation:"Eagle 原备注",url:"https://example.com/t14",isDeleted:false,btime:1756571097667,comments:[]}));
  writeFileSync(libraryMetadata,JSON.stringify({folders:[],applicationVersion:"4.0.0"}));
  const record=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:sha256(bytes)};};
  const eagle={sourceParent,root:eagleRoot,item,itemId,original:record(original),itemMetadata:record(itemMetadata),libraryMetadata:record(libraryMetadata),reusedFrom:"e2e/eagle-deletion-choice.mjs",reusedSourceSha256:sha256(readFileSync(new URL("./eagle-deletion-choice.mjs",import.meta.url)))};
  const schema = readFileSync(new URL("../crates/kinshoko-core/tests/fixtures/spec78-legacy-v16.sql", import.meta.url), "utf8");
  function legacy(key, name, names) {
    const libraryRoot = join(libraries, key); mkdirSync(libraryRoot);
    const identity = (suffix) => sha256(key+suffix).slice(0,32);
    const id=identity("library"), imageId=identity("image");
    const rel=`originals/${old.sha256.slice(0,2)}/${old.sha256}.png`;
    mkdirSync(join(libraryRoot,"originals",old.sha256.slice(0,2)),{recursive:true});
    const original=join(libraryRoot,rel);writeFileSync(original,readFileSync(old.path));
    const database=join(libraryRoot,"library.sqlite");
    const db=new DatabaseSync(database);db.exec(schema);
    db.prepare("INSERT INTO library VALUES (?,?,1,1000)").run(id,name);
    db.prepare("INSERT INTO image (id,sha256,size,format,rel_path,width,height,orientation,original_name,imported_at) VALUES (?,?,?,'png',?,3,3,1,'legacy.png',1000)").run(imageId,old.sha256,old.bytes,rel);
    const tags={};
    for(const [external,spec] of Object.entries(names)) {
      const {label,namespace="general"}=typeof spec==="string"?{label:spec}:spec;
      const local=identity(external);tags[external]=local;
      db.prepare("INSERT INTO tag VALUES (?,?,1000)").run(local,namespace);
      db.prepare("INSERT INTO tag_name VALUES (?,'zh-CN',?)").run(local,label);
      db.prepare("INSERT INTO tag_external VALUES (?,?)").run(external,local);
    }
    db.prepare("INSERT INTO tag_fact VALUES (?,?,'model:old',0.9)").run(imageId,tags.parted_hair);
    db.prepare("INSERT INTO tag_decision VALUES (?,?,'add',1000)").run(imageId,tags.parted_hair);
    db.close();
    return {info:{id,name,root:libraryRoot},imageId,tags,original,sha256:old.sha256,databaseInputSha256:sha256(readFileSync(database))};
  }
  const a=legacy("A","同名资料库",{parted_hair:"分发",blue_eyes:"蓝色眼睛",aqua_eyes:"水色眼睛",provider_a_meaning:"同名异义",sample_character:{label:"分发",namespace:"character"}});
  const b=legacy("B","同名资料库",{parted_hair:"分开的头发",blue_eyes:"蓝瞳旧名",aqua_eyes:"水色瞳旧名",provider_b_meaning:"同名异义",sample_character:{label:"分发",namespace:"character"}});
  const fixture={kind:"spec78-t20-two-provider-input",generatedAt:new Date().toISOString(),generatorSha256:sha256(readFileSync(new URL(import.meta.url))),schemaSha256:sha256(schema),root,libraries,a,b,eagle,inputs:{old,visible,sealed,unknown,incoming,virtual,eagleFirst,eagleNew},longImportCount:2000};
  writeFileSync(join(root,"generator.mjs"),readFileSync(new URL(import.meta.url)));
  writeFileSync(join(root,"legacy-v16.sql"),schema);
  writeFileSync(join(root,"fixture.json"),JSON.stringify(fixture,null,2));
  return fixture;
}
