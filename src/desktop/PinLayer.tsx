import { useEffect, useState } from "react";
import { layerPins, onLayerFrame, onPinGone } from "../ipc";
import { PinKeys } from "./pinKeys";
import { PinView } from "./PinView";

/**
 * 钉图层（#193）：一台显示器上的全部钉图画在同一个铺满屏幕的透明窗口里，每个钉图是一个
 * [`PinView`]。层的原生窗口从不移动，窗口区域由应用壳设成各钉图区域的并集。
 *
 * 有钉图进来时应用壳先发它的帧，层据此加上它；钉图离开（关闭、拖到别的显示器、交给另一个层）时
 * 收到 `pin-gone`。快捷键由 [`PinKeys`] 分给光标下（或最近按过）的钉图。
 */
export function PinLayer() {
  const [pins, setPins] = useState<string[]>([]);
  const [keys] = useState(() => new PinKeys());

  useEffect(() => keys.attach(window), [keys]);

  useEffect(() => {
    let alive = true;
    const add = (pin: string) => setPins((list) => (list.includes(pin) ? list : [...list, pin]));
    const frames = onLayerFrame((f) => {
      if (alive) add(f.pin.id);
    });
    const gone = onPinGone((pin) => {
      if (alive) setPins((list) => list.filter((p) => p !== pin));
    });
    // 先挂监听再取一次，加载期间进来的钉图也不漏。
    void Promise.all([frames, gone])
      .then(() => layerPins())
      .then((list) => {
        if (alive) list.forEach(add);
      });
    return () => {
      alive = false;
      void frames.then((stop) => stop());
      void gone.then((stop) => stop());
    };
  }, []);

  return (
    <>
      {pins.map((pin) => (
        <PinView key={pin} pin={pin} keys={keys} />
      ))}
    </>
  );
}
