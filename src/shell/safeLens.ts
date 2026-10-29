/**
 * 主窗口的安全模式：开关上显示的状态（`shown`）与查询资料库用的视角（`lens`）分开（#183）。
 *
 * - 开启：两者当即变成开。查询只会更严，资料库还没跟上时它拒绝旧视角，不会露出内容。
 * - 关闭：开关当即显示为关，封印书开始打开；查询视角等后端确认（`set_safe_mode` 返回）才放开。
 *   之前按“关”发出的查询资料库还会拒绝（或排在写设置之后），确认后又整批重来，白白占着后端。
 * - 切换还没确认时，到达的旧事件不覆盖之后的点击；全部返回后与最后一次点击一致才采纳，
 *   否则重新读取设置校准。外部报告“开”随时收紧视角。
 */
export type SafeLens = {
  /** 开关上显示的状态。 */
  shown: boolean;
  /** 查询资料库用的视角；为 false 时后端已确认关闭。 */
  lens: boolean;
  /** 已发出、还没返回的切换。 */
  pending: number;
};

export type SafeLensAction =
  /** 画师点了开关。 */
  | { kind: "toggle" }
  /** 一次切换在后端提交完成，`on` 是后端返回的状态。 */
  | { kind: "settled"; on: boolean }
  /** 一次切换失败；调用方随后重新读取设置，以 `external` 送回。 */
  | { kind: "failed" }
  /** 读到的设置或后端推送的变化（启动、恢复设置、资料库确认）。 */
  | { kind: "external"; on: boolean };

/** 读到设置之前按开启处理，不会先露出被封印的图。 */
export const INITIAL_SAFE_LENS: SafeLens = { shown: true, lens: true, pending: 0 };

export function reduceSafeLens(state: SafeLens, action: SafeLensAction): SafeLens {
  switch (action.kind) {
    case "toggle": {
      const next = !state.shown;
      return { shown: next, lens: next || state.lens, pending: state.pending + 1 };
    }
    case "settled": {
      const pending = Math.max(0, state.pending - 1);
      // 返回的顺序不一定是后端提交的顺序：只采纳与最后一次点击一致的结果。
      // 不一致时保持现状（视角不放开），调用方重新读取设置后以 `external` 校准。
      if (pending === 0 && action.on === state.shown) return { shown: action.on, lens: action.on, pending };
      return { ...state, lens: state.lens || action.on, pending };
    }
    case "failed": {
      const pending = Math.max(0, state.pending - 1);
      // 开关回到视角的状态（关闭失败时仍是开），之后以重新读取的设置为准。
      return pending === 0 ? { shown: state.lens, lens: state.lens, pending } : { ...state, pending };
    }
    case "external":
      if (state.pending === 0) return { ...state, shown: action.on, lens: action.on };
      return action.on && !state.lens ? { ...state, lens: true } : state;
  }
}

/** 一次切换返回后是否要重新读取设置：返回的状态与最后一次点击不一致（返回乱序）。 */
export function needsRecheck(state: SafeLens, settledOn: boolean): boolean {
  return state.pending === 0 && settledOn !== state.shown;
}
