import { I_STAR } from "./OriginalStar";

/** 人工标签名前的小金星（#482）：logo 里 `i` 上的星，约为字号的 0.72，底边落在文字基线上（`.k-manual-star`）。 */
export function ManualStar() {
  return <svg className="k-manual-star" viewBox="106 32 52 52" aria-hidden="true" focusable="false"><path d={I_STAR} /></svg>;
}
