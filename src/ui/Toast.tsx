import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { Tip } from "./Tip";

export type ToastTone = "success" | "info" | "error";
export type ToastOptions = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. Errors default to 0 so a real failure is never lost. */
  timeout?: number;
  /** Choosing the action closes the toast, unless `keepOpen` (the caller then updates it in place, e.g. 安装 → 正在下载). */
  action?: { label: string; onClick: () => void; keepOpen?: boolean };
  /** Called once the toast closes, whether dismissed by the artist or closed by code. */
  onClose?: () => void;
  /**
   * 排队的常驻通知（#609）：同一时间只显示一条，关掉或处理完再出下一条；数字小的先出，同级按先来后到。
   * 次序见 `NOTICE_ORDER` 与 design/ui-system/interaction-flows.md。
   */
  queue?: number;
};

/** 排队通知的次序（#609）：先出影响眼下能不能用的，再出提醒，最后是整理类的。 */
export const NOTICE_ORDER = {
  loginExpired: 1,
  runtime: 2,
  backup: 3,
  update: 4,
  legacyNames: 5,
} as const;
export type ToastApi = {
  show: (options: ToastOptions) => string;
  /** A real error: announced urgently, stays until 知道了 or its action is chosen. */
  error: (message: string, options?: Omit<ToastOptions, "title" | "tone">) => string;
  /** Replaces a shown toast's content in place (e.g. progress, or a failure after an action); keeps its onClose. */
  update: (id: string, options: Omit<ToastOptions, "onClose">) => void;
  close: (id: string) => void;
};

const Manager = createContext<ToastApi | null>(null);

/** 带操作（如“撤销”）的提示多留一会儿：看完再伸手去点要比读一句话久。悬停时照常暂停计时。 */
const ACTION_TIMEOUT = 8000;

function Bridge({ children }: { children: ReactNode }) {
  // The manager object changes identity between renders; keep the API stable so it can sit in effect deps.
  const manager = Toast.useToastManager();
  const latest = useRef(manager);
  latest.current = manager;
  const api = useMemo<ToastApi>(() => {
    const content = (
      { title, description, tone = "info", timeout, action }: Omit<ToastOptions, "onClose">,
      id: () => string,
    ) => ({
      title,
      description,
      type: tone,
      timeout: timeout ?? (tone === "error" ? 0 : action ? ACTION_TIMEOUT : 5000),
      priority: tone === "error" ? ("high" as const) : ("low" as const),
      actionProps: action
        ? {
            children: action.label,
            onClick: () => {
              action.onClick();
              if (!action.keepOpen) latest.current.close(id());
            },
          }
        : undefined,
    });
    /** 排队通知：正在显示的那一条，与等着的（按次序、先来后到）。 */
    let active: string | null = null;
    const waiting: { id: string; queue: number; options: ToastOptions }[] = [];
    let serial = 0;
    const present = (id: string, { onClose, queue: _queue, ...options }: ToastOptions) => {
      active = id;
      latest.current.add({
        ...content(options, () => id),
        id,
        onClose: () => {
          if (active === id) {
            active = null;
            const next = waiting.shift();
            if (next) present(next.id, next.options);
          }
          onClose?.();
        },
      });
    };
    const show = (options: ToastOptions): string => {
      if (options.queue !== undefined) {
        const id = `notice-${++serial}`;
        if (active === null) present(id, options);
        else {
          const at = waiting.findIndex((w) => w.queue > (options.queue ?? 0));
          waiting.splice(at === -1 ? waiting.length : at, 0, { id, queue: options.queue, options });
        }
        return id;
      }
      const { onClose, ...rest } = options;
      let id = "";
      id = latest.current.add({ ...content(rest, () => id), onClose });
      return id;
    };
    return {
      show,
      error: (message, options = {}) => show({ ...options, title: message, tone: "error" }),
      update: (id, options) => {
        const queued = waiting.find((w) => w.id === id);
        if (queued) queued.options = { ...options, onClose: queued.options.onClose, queue: queued.queue };
        else
          latest.current.update(
            id,
            content(options, () => id),
          );
      },
      close: (id) => {
        const at = waiting.findIndex((w) => w.id === id);
        if (at === -1) return latest.current.close(id);
        const [queued] = waiting.splice(at, 1);
        queued.options.onClose?.();
      },
    };
  }, []);
  return <Manager value={api}>{children}</Manager>;
}

const icons = { success: CircleCheck, info: Info, error: CircleAlert } as const;

function Stack() {
  const { t } = useTranslation("shell");
  const { toasts, close } = Toast.useToastManager();
  // The collapsed stack's height (frontmost toast plus an 8 px peek per older one, plus the gap), published on the root so the
  // import task cards sharing this corner sit above it instead of underneath (#388).
  const shown = toasts.filter((toast) => toast.transitionStatus !== "ending" && !toast.limited);
  const stack = shown.length === 0 ? 0 : (shown[0].height ?? 0) + (shown.length - 1) * 8 + 8;
  useEffect(() => {
    document.documentElement.style.setProperty("--k-toast-stack", `${stack}px`);
    return () => {
      document.documentElement.style.removeProperty("--k-toast-stack");
    };
  }, [stack]);
  return toasts.map((toast) => {
    const Icon = icons[(toast.type as ToastTone | undefined) ?? "info"] ?? Info;
    return (
      <Toast.Root key={toast.id} toast={toast} className="k-toast" data-tone={toast.type}>
        {/* Content clips a taller toast to the frontmost one's height while the stack is collapsed. */}
        <Toast.Content className="k-toast-content">
          <span className="k-toast-icon">
            <Icon size={16} aria-hidden="true" />
          </span>
          <div className="k-toast-text">
            <Toast.Title className="k-toast-title" />
            <Toast.Description className="k-toast-desc" />
          </div>
          {toast.actionProps && <Toast.Action className="k-toast-action" />}
          {/* Our own close: Base UI's Toast.Close hides itself from assistive tech while the stack is collapsed. */}
          <Tip label={toast.type === "error" ? t("toast.gotIt") : t("toast.dismiss")}>
            <button
              type="button"
              className="k-toast-close"
              aria-label={toast.type === "error" ? t("toast.gotIt") : t("toast.dismissLabel")}
              onClick={() => close(toast.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </Tip>
        </Toast.Content>
      </Toast.Root>
    );
  });
}

/**
 * Toast stack (Base UI Toast) replacing the sticky red banners: bottom-right, collapsed behind the newest toast until
 * hovered or focused, auto-dismissing for confirmations, persistent for real errors. Mount once around the window's content.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("shell");
  return (
    <Toast.Provider limit={4}>
      <Bridge>{children}</Bridge>
      <Toast.Portal>
        <Toast.Viewport className="k-toasts" aria-label={t("toast.label")}>
          <Stack />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Manager);
  if (!api) throw new Error("useToast outside a ToastProvider");
  return api;
}

/** 有 ToastProvider 时同 `useToast`，没有时为空（例如只挂一块界面的单测）。 */
export function useOptionalToast(): ToastApi | null {
  return useContext(Manager);
}

export type PersistentToast = Pick<ToastOptions, "title" | "description" | "tone" | "action">;

/**
 * A notice about something still waiting on the artist: stays until dismissed or until `notice` becomes null, updates in
 * place (including on a language change, since the caller's strings change), and stays away once dismissed.
 * `hidden` only steps aside while the artist is already dealing with it (a dialog above it) and forgets nothing.
 * Without `level`, a dismissal lasts until `notice` next becomes null, so a new occurrence shows again;
 * with `level`, it lasts until the level exceeds the one dismissed.
 */
export function usePersistentToast(
  notice: PersistentToast | null,
  { hidden = false, level, queue }: { hidden?: boolean; level?: number; queue?: number } = {},
) {
  const toast = useToast();
  const latest = useRef({ notice, level });
  latest.current = { notice, level };
  const shown = useRef<string | null>(null);
  const dismissedAt = useRef<number | null>(null);
  const close = () => {
    const id = shown.current;
    shown.current = null;
    if (id !== null) toast.close(id);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: notice 每次渲染都是新对象，按它显示出来的各项比较，内容没变就不重放
  useEffect(() => {
    if (!notice && level === undefined) dismissedAt.current = null;
    if (!notice || hidden || (dismissedAt.current !== null && (level ?? 0) <= dismissedAt.current)) {
      close();
      return;
    }
    dismissedAt.current = null;
    const { title, description, tone, action } = notice;
    const content = {
      title,
      description,
      tone,
      timeout: 0,
      // Its own lifetime rules decide when it goes, so choosing the action does not count as dismissing it.
      action: action && {
        label: action.label,
        onClick: () => latest.current.notice?.action?.onClick(),
        keepOpen: true,
      },
    };
    if (shown.current !== null) {
      toast.update(shown.current, content);
      return;
    }
    const id: string = toast.show({
      ...content,
      queue,
      onClose: () => {
        if (shown.current !== id) return;
        shown.current = null;
        dismissedAt.current = latest.current.level ?? 0;
      },
    });
    shown.current = id;
  }, [notice === null, notice?.title, notice?.description, notice?.tone, notice?.action?.label, hidden, level]);
  // biome-ignore lint/correctness/useExhaustiveDependencies(close): 只在卸载时收起；close 每次渲染都是新函数，只读 ref
  useEffect(() => close, []);
}
