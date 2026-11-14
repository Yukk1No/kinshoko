// 材质样本：主界面上只有查找框，这里把同一族的输入框、下拉与已定材质的按钮、滑条排在一起，看它们是不是一套东西。
// 用的是正式程序的类名（.k-input、.k-select、.k-btn、.k-range、.k-seg），不另写控件。
import { ChevronDown, Search } from "lucide-react";

export function Specimen() {
  return (
    <aside className="proto-specimen" aria-label="材质样本">
      <div className="proto-specimen-row">
        <label className="k-input"><Search size={16} aria-hidden="true" /><input placeholder="输入框" aria-label="输入框" /></label>
        <label className="k-input"><input defaultValue="逆光下的侧脸" aria-label="有内容的输入框" /></label>
      </div>
      <div className="proto-specimen-row">
        <button type="button" className="k-select"><span className="k-select-value">工作参考</span><ChevronDown size={16} aria-hidden="true" /></button>
        <label className="k-input is-num"><input defaultValue="320" aria-label="数字" /></label>
      </div>
      <div className="proto-specimen-row">
        <button type="button" className="k-btn">按钮</button>
        <button type="button" className="k-btn is-primary">主按钮</button>
        <input type="range" className="k-range" defaultValue={40} style={{ "--fill": "40%" } as React.CSSProperties} aria-label="滑条" />
      </div>
      <div className="k-seg" role="group" aria-label="分段">
        <span className="k-seg-thumb" style={{ width: "calc(50% - 5px)", height: 28, transform: "translate(4px, 4px)" }} />
        <button type="button" className="k-seg-item" data-pressed="">网格</button>
        <button type="button" className="k-seg-item">列表</button>
      </div>
    </aside>
  );
}
