// 还原度门槛实验页面（#45）：由 WebView2 自己解码样本原图与 Rust 生成的缩略图，画到
// `display-p3` canvas 读回，逐色块比较 ΔE2000。阈值 ΔE2000 < 1 为假设（验收约定）。
// 结果连同本机环境保存为 JSON 与 Markdown 报告。
import { useEffect, useState } from "react";
import type { GateItem } from "../bindings/GateItem";
import type { GatePlan } from "../bindings/GatePlan";
import type { PinGate } from "../bindings/PinGate";
import { gateImage, gatePins, gatePlan, gateSave } from "../ipc";
import { deltaE2000, p3ToLab, patchMean, type Lab } from "./colour";
import { Select } from "../ui/Select";
import { PinGateSection, pinGateMarkdown, pinGatePassed } from "./pinGate";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/instance";

/** 缩略图档位，与 Rust 门槛测试一致。 */
const THUMB_PX = 128;
const THRESHOLD = 1;
const ALPHA_TOLERANCE = 0.02;
/** 显示设置里开关类项目的填写选项；报告里写它的文字。 */
type DisplaySwitch = "unset" | "on" | "off" | "unsupported";
const DISPLAY_SWITCH: DisplaySwitch[] = ["unset", "on", "off", "unsupported"];
const t = i18n.getFixedT(null, "fidelity");
const switchText = (value: string) => t(`switch.${value as DisplaySwitch}`);
const sampleVerdict = (r: { error?: string | null; gated: boolean; passed: boolean }) =>
  r.error ? t("error", { error: r.error }) : !r.gated ? t("recordOnly") : r.passed ? t("passed") : t("failed");

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
    throw new Error(`${String(e)} (${bytes.length} bytes, starting ${head})`);
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { colorSpace: "display-p3", willReadFrequently: true });
  if (!ctx) throw new Error("cannot create canvas");
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

function markdown(plan: GatePlan, results: SampleResult[], pins: PinGate, env: object, manual: Manual, passed: boolean) {
  const lines = [
    t("report.title"),
    "",
    t("report.verdict", { verdict: t(passed ? "passed" : "failed"), threshold: THRESHOLD, px: THUMB_PX }),
    "",
    t("report.environment"),
    "",
    t("report.display", { hdr: switchText(manual.hdr), autoColour: switchText(manual.autoColour), icc: manual.monitorIcc || t("switch.unset") }),
    t("report.remarks", { remarks: manual.remarks || t("report.none") }),
    "",
    "```json",
    JSON.stringify({ app: plan.environment, page: env }, null, 2),
    "```",
    "",
    t("report.samples"),
    "",
    t("report.header"),
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const worst = (f: (p: PatchResult) => number) =>
      r.patches.length ? Math.max(...r.patches.map(f)).toFixed(2) : "—";
    const nominal = worst((p) => p.deltaENominal);
    const thumbNominal = worst((p) => p.deltaEThumbnailNominal);
    const direct = r.display === "sdrDerivative" ? worst((p) => p.direct?.deltaENominal ?? 0) : "—";
    const route = r.display === "sdrDerivative" ? t("report.derivative") : t("report.original");
    const verdict = sampleVerdict(r);
    lines.push(
      `| ${r.fileName} | ${r.group} | ${route} | ${t(r.gated ? "yes" : "no")} | ${r.maxDeltaE?.toFixed(2) ?? "—"} | ${nominal} | ${thumbNominal} | ${direct} | ${verdict} | \`${r.sha256.slice(0, 16)}…\` |`,
    );
  }
  lines.push("", ...pinGateMarkdown(pins));
  return lines.join("\n") + "\n";
}

export function FidelityGate() {
  const { t } = useTranslation("fidelity");
  const [plan, setPlan] = useState<GatePlan | null>(null);
  const [results, setResults] = useState<SampleResult[]>([]);
  const [pins, setPins] = useState<PinGate | null>(null);
  const [canvasSpace, setCanvasSpace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [manual, setManual] = useState<Manual>({ hdr: "unset", autoColour: "unset", monitorIcc: "", remarks: "" });
  const switchOptions = DISPLAY_SWITCH.map((value) => ({ value, label: t(`switch.${value}`) }));
  const done = plan !== null && results.length === plan.items.length && pins !== null;
  const passed = done && results.every((r) => !r.gated || (r.passed && !r.error)) && pinGatePassed(pins);

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
      const pins = await gatePins();
      if (cancelled) return;
      setPins(pins);
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!plan || !pins) return;
    const env = { ...browserEnvironment(), canvasColorSpace: canvasSpace };
    const report = {
      kind: "kinshoko-fidelity-gate",
      threshold: { deltaE2000: THRESHOLD, alpha: ALPHA_TOLERANCE, thumbnailPx: THUMB_PX },
      passed,
      environment: { app: plan.environment, page: env, manual },
      library: plan.library,
      samples: results.map(({ originalUrl: _o, thumbnailUrl: _t, ...r }) => r),
      pins,
    };
    try {
      setSaved(await gateSave(report, markdown(plan, results, pins, env, manual, passed), passed));
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
      <h1>{t("title")}</h1>
      <p>{t("intro", { threshold: THRESHOLD })}</p>
      {error && <p role="alert">{t("error", { error })}</p>}
      {!plan && !error && <p>{t("preparing")}</p>}
      {plan && (
        <p>
          {t("progress", { done: results.length, total: plan.items.length })}
          {canvasSpace && canvasSpace !== "display-p3" && t("canvasSpace", { space: canvasSpace })}
          {done && t("verdict", { verdict: t(passed ? "passed" : "failed") })}
        </p>
      )}
      {done && !plan?.autoSave && (
        <fieldset className="gate-manual">
          <legend>{t("manualLegend")}</legend>
          <div className="k-field">
            <span className="k-field-label">HDR</span>
            <Select label="HDR" value={manual.hdr} options={switchOptions} onChange={(hdr) => setManual({ ...manual, hdr })} />
          </div>
          <div className="k-field">
            <span className="k-field-label">{t("autoColour")}</span>
            <Select label={t("autoColour")} value={manual.autoColour} options={switchOptions} onChange={(autoColour) => setManual({ ...manual, autoColour })} />
          </div>
          <label className="k-field">
            <span className="k-field-label">{t("monitorIcc")}</span>
            <input className="k-input" value={manual.monitorIcc} onChange={(e) => setManual({ ...manual, monitorIcc: e.target.value })} />
          </label>
          <label className="k-field">
            <span className="k-field-label">{t("remarks")}</span>
            <input className="k-input" value={manual.remarks} onChange={(e) => setManual({ ...manual, remarks: e.target.value })} />
          </label>
          <button type="button" className="k-btn is-sm" onClick={() => void save()}>
            {t("save")}
          </button>
        </fieldset>
      )}
      {saved && <p>{t("saved", { path: saved })}</p>}
      <table className="gate-table">
        <thead>
          <tr>
            <th>{t("column.sample")}</th>
            <th>{t("column.shown")}</th>
            <th>{t("column.thumbnail")}</th>
            <th>{t("column.maxDeltaE")}</th>
            <th>{t("column.result")}</th>
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
              <td>{sampleVerdict(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan && <PinGateSection pins={pins} />}
    </main>
  );
}
