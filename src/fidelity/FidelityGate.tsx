// 还原度门槛实验页面（#45）：由 WebView2 自己解码样本原图与 Rust 生成的缩略图，画到
// `display-p3` canvas 读回，逐色块比较 ΔE2000。阈值 ΔE2000 < 1 为假设（验收约定）。
// 结果连同本机环境保存为 JSON 与 Markdown 报告。
import { useEffect, useState } from "react";
import type { GateItem } from "../bindings/GateItem";
import type { GatePlan } from "../bindings/GatePlan";
import { gateImage, gatePlan, gateSave } from "../ipc";
import { deltaE2000, p3ToLab, patchMean, type Lab } from "./colour";

/** 缩略图档位，与 Rust 门槛测试一致。 */
const THUMB_PX = 128;
const THRESHOLD = 1;
const ALPHA_TOLERANCE = 0.02;

interface PatchResult {
  /** display-p3 canvas 读回的平均编码值（0～1）：1:1 显示的图与缩略图。 */
  shownRgb: [number, number, number];
  thumbnailRgb: [number, number, number];
  shown: Lab;
  thumbnail: Lab;
  /** 1:1 显示的图与缩略图（都经 WebView2 解码）的色差：门槛。 */
  deltaE: number;
  /** 1:1 显示的图与样本标称值的色差。显示派生图时计入门槛；直接显示原图时是 WebView2 自己的解释，只记录。 */
  deltaENominal: number;
  /** 缩略图与样本标称值的色差：只记录，用来区分是哪一边偏了。 */
  deltaEThumbnailNominal: number;
  /** 显示派生图的样本：WebView2 直接解码原图的结果，只记录。 */
  direct?: { rgb: [number, number, number]; lab: Lab; deltaENominal: number };
  alpha: [number, number];
}

interface SampleResult {
  fileName: string;
  group: string;
  note: string;
  gated: boolean;
  sha256: string;
  /** 1:1 显示走哪条路（Library::display）：原图直接显示或原尺寸 sdr 派生图。 */
  display: GateItem["display"];
  /** WebView2 解码出的尺寸：确认确实解码了。 */
  decoded?: { shown: [number, number]; original: [number, number]; thumbnail: [number, number] };
  patches: PatchResult[];
  maxDeltaE: number | null;
  passed: boolean;
  error?: string;
  originalUrl?: string;
  thumbnailUrl?: string;
}

interface Canvas {
  colorSpace: string;
}

async function decode(bytes: Uint8Array<ArrayBuffer>): Promise<{ image: ImageData; url: string; canvas: Canvas }> {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob).catch((e: unknown) => {
    const head = Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ");
    throw new Error(`${String(e)}（${bytes.length} 字节，开头 ${head}）`);
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { colorSpace: "display-p3", willReadFrequently: true });
  if (!ctx) throw new Error("无法建立 canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: "display-p3" });
  return {
    image,
    url: URL.createObjectURL(blob),
    canvas: { colorSpace: ctx.getContextAttributes().colorSpace ?? "srgb" },
  };
}

async function measure(item: GateItem): Promise<SampleResult & { canvas: Canvas }> {
  const derivative = item.display === "sdrDerivative";
  const [original, shownOrNull, thumbnail] = await Promise.all([
    gateImage(item.imageId, "original").then(decode),
    derivative ? gateImage(item.imageId, "display").then(decode) : Promise.resolve(null),
    gateImage(item.imageId, { thumbnail: THUMB_PX }).then(decode),
  ]);
  // 应用在 1:1 时显示的图：派生图，或交给 WebView2 的原图。
  const shown = shownOrNull ?? original;
  const scale = thumbnail.image.width / item.width;
  const patches = item.patches.map((p): PatchResult => {
    const o = patchMean(shown.image, p);
    const t = patchMean(thumbnail.image, p, scale);
    const ol = p3ToLab(o.rgb);
    const tl = p3ToLab(t.rgb);
    let direct: PatchResult["direct"];
    if (derivative) {
      const d = patchMean(original.image, p);
      const dl = p3ToLab(d.rgb);
      direct = { rgb: d.rgb, lab: dl, deltaENominal: deltaE2000(dl, p.lab as Lab) };
    }
    return {
      shownRgb: o.rgb,
      thumbnailRgb: t.rgb,
      shown: ol,
      thumbnail: tl,
      deltaE: deltaE2000(ol, tl),
      deltaENominal: deltaE2000(ol, p.lab as Lab),
      deltaEThumbnailNominal: deltaE2000(tl, p.lab as Lab),
      direct,
      alpha: [o.alpha, t.alpha],
    };
  });
  const maxDeltaE = patches.length
    ? Math.max(...patches.map((p) => (derivative ? Math.max(p.deltaE, p.deltaENominal) : p.deltaE)))
    : null;
  const passed = patches.every(
    (p) =>
      p.deltaE < THRESHOLD &&
      (!derivative || p.deltaENominal < THRESHOLD) &&
      Math.abs(p.alpha[0] - p.alpha[1]) <= ALPHA_TOLERANCE,
  );
  return {
    fileName: item.fileName,
    group: item.group,
    note: item.note,
    gated: item.gated,
    sha256: item.sha256,
    display: item.display,
    decoded: {
      shown: [shown.image.width, shown.image.height],
      original: [original.image.width, original.image.height],
      thumbnail: [thumbnail.image.width, thumbnail.image.height],
    },
    patches,
    maxDeltaE,
    passed,
    originalUrl: shown.url,
    thumbnailUrl: thumbnail.url,
    canvas: original.canvas,
  };
}

/** 页面能读到的显示环境。 */
function browserEnvironment() {
  const media = (q: string) => window.matchMedia(q).matches;
  let gpu: string | null = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    gpu = null;
  }
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
    colorGamut: media("(color-gamut: rec2020)") ? "rec2020" : media("(color-gamut: p3)") ? "p3" : "srgb",
    dynamicRangeHigh: media("(dynamic-range: high)"),
    webglRenderer: gpu,
  };
}

interface Manual {
  hdr: string;
  autoColour: string;
  monitorIcc: string;
  remarks: string;
}

function markdown(plan: GatePlan, results: SampleResult[], env: object, manual: Manual, passed: boolean) {
  const lines = [
    "# Kinshoko 还原度门槛实验报告",
    "",
    `结论：${passed ? "通过" : "未通过"}（阈值 ΔE2000 < ${THRESHOLD}，为假设值；缩略图 ${THUMB_PX} px）`,
    "",
    "## 环境",
    "",
    `- Windows HDR：${manual.hdr}；自动色彩管理：${manual.autoColour}；显示器 ICC：${manual.monitorIcc || "未填写"}`,
    `- 备注：${manual.remarks || "无"}`,
    "",
    "```json",
    JSON.stringify({ app: plan.environment, page: env }, null, 2),
    "```",
    "",
    "## 样本",
    "",
    "| 样本 | 实验 | 1:1 显示 | 门槛 | 最大 ΔE2000（门槛） | 1:1 显示 vs 标称 | 缩略图 vs 标称 | WebView2 直接显示原图 vs 标称（只记录） | 结果 | SHA-256 |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const worst = (f: (p: PatchResult) => number) =>
      r.patches.length ? Math.max(...r.patches.map(f)).toFixed(2) : "—";
    const nominal = worst((p) => p.deltaENominal);
    const thumbNominal = worst((p) => p.deltaEThumbnailNominal);
    const direct = r.display === "sdrDerivative" ? worst((p) => p.direct?.deltaENominal ?? 0) : "—";
    const route = r.display === "sdrDerivative" ? "派生图" : "原图";
    const verdict = r.error ? `出错：${r.error}` : !r.gated ? "只记录" : r.passed ? "通过" : "未通过";
    lines.push(
      `| ${r.fileName} | ${r.group} | ${route} | ${r.gated ? "是" : "否"} | ${r.maxDeltaE?.toFixed(2) ?? "—"} | ${nominal} | ${thumbNominal} | ${direct} | ${verdict} | \`${r.sha256.slice(0, 16)}…\` |`,
    );
  }
  return lines.join("\n") + "\n";
}

export function FidelityGate() {
  const [plan, setPlan] = useState<GatePlan | null>(null);
  const [results, setResults] = useState<SampleResult[]>([]);
  const [canvasSpace, setCanvasSpace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [manual, setManual] = useState<Manual>({ hdr: "未填写", autoColour: "未填写", monitorIcc: "", remarks: "" });
  const done = plan !== null && results.length === plan.items.length;
  const passed = done && results.every((r) => !r.gated || (r.passed && !r.error));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await gatePlan();
      if (cancelled) return;
      setPlan(p);
      for (const item of p.items) {
        let result: SampleResult;
        try {
          const { canvas, ...r } = await measure(item);
          setCanvasSpace(canvas.colorSpace);
          result = r;
        } catch (e) {
          result = {
            fileName: item.fileName,
            group: item.group,
            note: item.note,
            gated: item.gated,
            sha256: item.sha256,
            display: item.display,
            patches: [],
            maxDeltaE: null,
            passed: false,
            error: String(e),
          };
        }
        if (cancelled) return;
        setResults((rs) => [...rs, result]);
      }
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!plan) return;
    const env = { ...browserEnvironment(), canvasColorSpace: canvasSpace };
    const report = {
      kind: "kinshoko-fidelity-gate",
      threshold: { deltaE2000: THRESHOLD, alpha: ALPHA_TOLERANCE, thumbnailPx: THUMB_PX },
      passed,
      environment: { app: plan.environment, page: env, manual },
      library: plan.library,
      samples: results.map(({ originalUrl: _o, thumbnailUrl: _t, ...r }) => r),
    };
    try {
      setSaved(await gateSave(report, markdown(plan, results, env, manual, passed), passed));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (done && plan?.autoSave) void save();
    // 只在跑完时自动保存一次。
  }, [done]);

  return (
    <main className="gate">
      <h1>还原度门槛实验</h1>
      <p>
        WebView2 分别解码应用在 1:1 时显示的图（原图，或动图、HDR、查找表型 ICC 与 CMYK 的原尺寸派生图）与缩略图，
        在 display-p3 canvas 中读回色块，比较 ΔE2000（阈值 {THRESHOLD}，假设值）；显示派生图的样本还须与标称值相差 &lt; {THRESHOLD}。
        直接显示原图时“1:1 显示 vs 标称”是 WebView2 自己的解释，只记录。
      </p>
      {error && <p role="alert">出错：{error}</p>}
      {!plan && !error && <p>正在生成样本并导入……</p>}
      {plan && (
        <p>
          {results.length}/{plan.items.length} 个样本
          {canvasSpace && canvasSpace !== "display-p3" && `；注意：canvas 色彩空间为 ${canvasSpace}`}
          {done && `；结论：${passed ? "通过" : "未通过"}`}
        </p>
      )}
      {done && !plan?.autoSave && (
        <fieldset className="gate-manual">
          <legend>请对照 Windows 设置 → 系统 → 屏幕 填写</legend>
          <label>
            HDR
            <select value={manual.hdr} onChange={(e) => setManual({ ...manual, hdr: e.target.value })}>
              <option>未填写</option>
              <option>开启</option>
              <option>关闭</option>
              <option>不支持</option>
            </select>
          </label>
          <label>
            自动色彩管理
            <select value={manual.autoColour} onChange={(e) => setManual({ ...manual, autoColour: e.target.value })}>
              <option>未填写</option>
              <option>开启</option>
              <option>关闭</option>
              <option>不支持</option>
            </select>
          </label>
          <label>
            显示器 ICC（颜色管理中的默认配置文件）
            <input value={manual.monitorIcc} onChange={(e) => setManual({ ...manual, monitorIcc: e.target.value })} />
          </label>
          <label>
            备注（例如肉眼看到的差异）
            <input value={manual.remarks} onChange={(e) => setManual({ ...manual, remarks: e.target.value })} />
          </label>
          <button type="button" onClick={() => void save()}>
            保存报告
          </button>
        </fieldset>
      )}
      {saved && <p>报告已保存：{saved}</p>}
      <table className="gate-table">
        <thead>
          <tr>
            <th>样本</th>
            <th>1:1 显示</th>
            <th>缩略图</th>
            <th>最大 ΔE2000</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.fileName}>
              <td>
                <strong>{r.fileName}</strong>
                <br />
                {r.note}
              </td>
              <td>{r.originalUrl && <img src={r.originalUrl} alt="" width={THUMB_PX} />}</td>
              <td>
                {r.thumbnailUrl && (
                  // 按设备像素 1:1 显示缩略图。
                  <img src={r.thumbnailUrl} alt="" style={{ width: THUMB_PX / window.devicePixelRatio }} />
                )}
              </td>
              <td>{r.maxDeltaE?.toFixed(2) ?? "—"}</td>
              <td>{r.error ? `出错：${r.error}` : !r.gated ? "只记录" : r.passed ? "通过" : "未通过"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
