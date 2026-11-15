/**
 * 快捷键的显示：每个键一枚键帽（`.k-key`），`KeyA` 写成 `A`；读屏读到的是完整写法。
 * 键之间用 `+` 或空格分开（`Ctrl+Shift+S`、`Ctrl B`）。设置、悬停提示和浮动名称共用。
 */
export function Keys({ accelerator }: { accelerator: string }) {
  return (
    <span className="k-keys" aria-label={accelerator}>
      {accelerator
        .split(/\+| /)
        .filter(Boolean)
        .map((key, index) => (
          <kbd key={index} className="k-key" aria-hidden="true">
            {key.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "")}
          </kbd>
        ))}
    </span>
  );
}
