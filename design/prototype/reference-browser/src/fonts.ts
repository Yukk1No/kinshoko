// The UI fonts confirmed in #28: Inter 4.1 static hinted 400 / 500 / 600 for Latin and digits, the full
// Source Han Sans SC VF for CJK (regional glyphs via lang). Registered from script rather than @font-face
// so the files stay next to index.html (fetched by scripts/fetch_fonts.py) instead of being inlined.
// A missing file only leaves the system fallback in the stack.
const at = (file: string) => `url("${new URL(`fonts/${file}`, document.baseURI).href}") format("woff2")`;
const HAN = 'SourceHanSansSC-VF.ttf.woff2';

const faces = [
  new FontFace('Kinshoko Inter', at('Inter-Regular.woff2'), { weight: '400', display: 'swap' }),
  new FontFace('Kinshoko Inter', at('Inter-Medium.woff2'), { weight: '500', display: 'swap' }),
  new FontFace('Kinshoko Inter', at('Inter-SemiBold.woff2'), { weight: '600', display: 'swap' }),
  // Without the 250–900 range the variable face counts as a single 400 and 500 / 600 never reach the axis.
  new FontFace('Kinshoko Han', at(HAN), { weight: '250 900', display: 'swap' }),
  // Same file, only the punctuation Inter also covers, so zh / ja text gets full-width dashes, ellipses, quotes.
  new FontFace('Kinshoko Han Punct', at(HAN), { weight: '250 900', display: 'swap', unicodeRange: 'U+2014, U+2018-2019, U+201C-201D, U+2026' }),
];
for (const f of faces) {
  document.fonts.add(f);
  f.load().catch(() => { /* not fetched yet: system fallback */ });
}
