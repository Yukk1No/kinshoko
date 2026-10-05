import { Dialog } from './Overlays';
import { clearLog, readLog } from '../log';
import { useState } from 'react';

export type Settings = {
  theme: 'system' | 'light' | 'dark';
  reducedMotion: boolean;
  density: number;
  capTall: boolean;
  showTitles: boolean;
  square: boolean;
  inflate: boolean;
  logging: boolean;
  stats: boolean;
  /** While a release plays (#27): Q110 candidates A / B, or Q105 "可打断". */
  releaseInput: 'block' | 'allow' | 'interrupt';
  /** Slow the seal and release effects ×5 for frame-by-frame checks. */
  fxSlow: boolean;
};

type Props = {
  settings: Settings;
  info: { missing: boolean; hasPredictions: boolean; skipped: number };
  onChange: (s: Settings) => void;
  onClose: () => void;
  onExportLog: () => void;
  onReset: () => void;
  onHelp: () => void;
};

export function SettingsDialog({ settings: s, info, onChange, onClose, onExportLog, onReset, onHelp }: Props) {
  const [entries, setEntries] = useState(() => readLog().length);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  return <Dialog title="设置与样稿说明" wide onClose={onClose} actions={<>
    <button onClick={onHelp}>快捷键</button>
    <button className="primary" onClick={onClose}>完成</button>
  </>}>
    <div className="settings">
      <fieldset>
        <legend>外观</legend>
        <label className="field"><span>主题</span>
          <select value={s.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
            <option value="system">跟随系统</option><option value="light">日间（纸白 · 墨紫 · 樱粉）</option><option value="dark">夜间（墨紫 · 奶油 · 金）</option>
          </select></label>
        <label className="check"><input type="checkbox" checked={s.reducedMotion} onChange={(e) => set('reducedMotion', e.target.checked)} />减少动画（系统设置为减少时也会生效）</label>
      </fieldset>
      <fieldset>
        <legend>安全模式</legend>
        <p className="muted small">开启时成人图收进封印书，不出现在图片墙和查找结果里；参考组和钉图里原位模糊。关闭时书打开，图飞回原位。</p>
        <label className="field"><span>释放期间</span>
          <select value={s.releaseInput} onChange={(e) => set('releaseInput', e.target.value as Settings['releaseInput'])}>
            <option value="allow">完整播放，图片墙照常操作（候选 B）</option>
            <option value="block">完整播放，播完前图片墙和侧栏不响应（候选 A）</option>
            <option value="interrupt">可打断：在图片墙上一操作就直接播完</option>
          </select></label>
        <p className="muted small">释放约 1.2 秒。无论选哪项，释放中途再开启安全模式都会立即掉头封印。</p>
      </fieldset>
      <fieldset>
        <legend>图片墙</legend>
        <label className="field"><span>图片大小</span><input type="range" min={140} max={420} step={10} value={s.density} onChange={(e) => set('density', Number(e.target.value))} /><span className="tabular">{s.density}px</span></label>
        <label className="check"><input type="checkbox" checked={s.capTall} onChange={(e) => set('capTall', e.target.checked)} />极长图限高（整张等比缩小，不裁切）</label>
        <label className="check"><input type="checkbox" checked={s.square} onChange={(e) => set('square', e.target.checked)} />改用等尺寸网格（只作空间利用对照）</label>
        <label className="check"><input type="checkbox" checked={s.showTitles} onChange={(e) => set('showTitles', e.target.checked)} />在图片下显示名称</label>
      </fieldset>
      <fieldset>
        <legend>试用记录</legend>
        <label className="check"><input type="checkbox" checked={s.logging} onChange={(e) => set('logging', e.target.checked)} />记录使用日志（默认关闭）</label>
        <p className="muted small">只写在这台电脑的浏览器里：查找条件、打开与钉住了哪张图（以样本哈希前缀记录，不含文件名和图片）。由你决定是否导出发给开发者。</p>
        <div className="row-actions">
          <button className="tool small" onClick={onExportLog} disabled={!entries}>导出日志（{entries} 条）</button>
          <button className="tool small" onClick={() => { clearLog(); setEntries(0); }} disabled={!entries}>清空</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>开发者检查</legend>
        <label className="check"><input type="checkbox" checked={s.inflate} onChange={(e) => set('inflate', e.target.checked)} />把「角色参考」重复到 10,000 条（只看布局与 DOM 数量，不代表真实图库性能）</label>
        <label className="check"><input type="checkbox" checked={s.stats} onChange={(e) => set('stats', e.target.checked)} />显示列数、挂载卡片数与上一次封印／释放的帧率</label>
        <label className="check"><input type="checkbox" checked={s.fxSlow} onChange={(e) => set('fxSlow', e.target.checked)} />封印／释放特效慢放 ×5（逐帧核对 0.3 秒门槛用）</label>
      </fieldset>
      <fieldset>
        <legend>这份样稿是什么</legend>
        <ul className="scope">
          <li>为 #13 做的一次性交互样稿：找图 → 看清 → 框选局部 → 钉住 → 再找 → 存成参考组 → 重开。</li>
          <li>图片来自验收样本清单（pixiv 公开作品，不进仓库）{info.skipped ? `，${info.skipped} 张本地缺失已跳过` : ''}；另有 5 张自制显示测试图。</li>
          <li>标签是 pixiv 作者标签映射成的来源标签；{info.hasPredictions ? '自动标签来自 #6 打标结果。' : '尚未并入 #6 的 PixAI 打标结果。'}文件夹是按标签构造的示例整理。</li>
          <li>钉图是网页内的模拟：正式版是置顶在绘画软件之上的独立窗口（见 #7 / PR #21）。截图用剪贴板图片代替。</li>
          <li>整理决定、参考组与钉图保存在这台电脑的浏览器里；截图和拖入的图片只在本次运行中存在。</li>
        </ul>
        <button className="tool small danger" onClick={onReset}>清除样稿保存的全部数据</button>
      </fieldset>
    </div>
  </Dialog>;
}

const KEYS: [string, string][] = [
  ['/', '聚焦查找框'], ['Enter', '查找输入的文字（匹配全部同名标签）'], ['↓ 后 Enter', '只选下拉中的一个标签'], ['Alt+Enter', '与上一个条件任一满足'], ['Backspace', '删除最后一个条件'],
  ['方向键', '在图片墙中移动'], ['Enter / 单击', '查看原图'], ['Esc', '关闭活动钉图；否则返回图片墙'], ['P', '钉住整图'], ['Delete', '移到回收站'],
  ['F1 或 Shift+拖动', '（查看时）框选局部'], ['0 / 1', '适应窗口 / 原图像素'], ['← →', '（查看时）上一张 / 下一张'], ['I', '信息栏'],
  ['F3 / Ctrl+V', '钉住剪贴板图片'], ['F4', '全部钉图贴边隐藏 / 回到原位'], ['H V R L', '（活动钉图）翻转、旋转、锁定'], ['Esc / Delete', '（活动钉图）关闭'], ['滚轮 / Ctrl+滚轮', '（钉图）缩放 / 透明度'],
  ['Ctrl+1 2 3', '图片与文件夹 / 参考组 / 截图历史'], ['Ctrl+B', '收起或展开侧栏'], ['Ctrl+Shift+S', '安全模式'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return <Dialog title="快捷键" onClose={onClose} actions={<button className="primary" onClick={onClose}>知道了</button>}>
    <dl className="keys">{KEYS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
  </Dialog>;
}
