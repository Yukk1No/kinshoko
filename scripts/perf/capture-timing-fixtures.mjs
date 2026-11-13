import { spawnSync } from "node:child_process";

// 合成原图并写入 source，返回文件名列表，原样从 capture-timing.mjs 移出。
export function generateFixtures(python, source) {
  // 合成原图：渐变叠低幅噪声，压缩后的体积接近真实插画／照片。同一种子逐字节相同。
  const FIXTURES = (
    process.env.KINSHOKO_CAPTURE_FIXTURES ??
    "a-2400x1600.png,b-6000x4000.png,c-6000x4000.jpg,d-9000x6000.jpg,e-6000x4000.webp"
  ).split(",");
  const generated = spawnSync(
    python,
    [
      "-I",
      "-c",
      `
import sys, random
from PIL import Image
out = sys.argv[1]
for spec in sys.argv[2:]:
    name, ext = spec.rsplit('.', 1)
    w, h = map(int, name.split('-')[1].split('x'))
    rng = random.Random(name)
    base = Image.linear_gradient('L').resize((w, h))
    noise = Image.frombytes('L', (w, h), rng.randbytes(w * h))
    r = Image.blend(base, noise, 0.25)
    g = Image.blend(base.transpose(Image.Transpose.ROTATE_90).resize((w, h)), noise, 0.15)
    b = Image.blend(base.transpose(Image.Transpose.FLIP_TOP_BOTTOM), noise, 0.35)
    im = Image.merge('RGB', (r, g, b))
    fmt = {'png': 'PNG', 'jpg': 'JPEG', 'webp': 'WEBP'}[ext]
    im.save(f"{out}/{spec}", fmt, **({'quality': 90} if fmt != 'PNG' else {}))
`,
      source,
      ...FIXTURES,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);

  return FIXTURES;
}
