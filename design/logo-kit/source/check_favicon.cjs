const {chromium}=require('playwright');
const sharp=require('sharp');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
  const root=path.resolve(__dirname,'..');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const result={};
  try{
    const page=await browser.newPage({viewport:{width:16,height:16},deviceScaleFactor:1});
    for(const [appearance,expected] of [['light',[247,243,234]],['dark',[43,39,71]]]){
      await page.emulateMedia({colorScheme:appearance});
      await page.goto(pathToFileURL(path.join(root,'web/favicon.svg')).href);
      const png=await page.screenshot({omitBackground:true});
      const raw=await sharp(png).ensureAlpha().raw().toBuffer();
      const offset=(8*16+1)*4;
      const rgb=[...raw.subarray(offset,offset+3)];
      if(rgb.some((v,i)=>v!==expected[i]))throw Error(`Favicon theme failed: ${appearance} / ${rgb}`);
      result[appearance]={tile_rgb:rgb,passed:true};
    }
    const mask=await sharp(path.join(root,'web/png/icon-day-maskable-512.png')).ensureAlpha().stats();
    if(mask.channels[3].min!==255)throw Error('Maskable icon is not fully opaque');
    result.maskable_opaque=true;
    fs.writeFileSync(path.join(root,'docs/favicon-check.json'),JSON.stringify(result,null,2));
    console.log('SVG favicon light/dark appearance and opaque maskable canvas verified.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
