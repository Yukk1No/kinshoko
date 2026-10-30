import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

export type ToastTone = "success" | "info" | "error";
export type ToastOptions = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. Errors default to 0 so a real failure is never lost. */
  timeout?: number;
  action?: { label: string; onClick: () => void };
  /** Called once the toast closes, whether dismissed by the artist or closed by code. */
  onClose?: () => void;
};
export type ToastApi = {
  show: (options: ToastOptions) => string;
  /** A real error: announced urgently, stays until 知道了 or its action is chosen. */
  error: (message: string, options?: Omit<ToastOptions, "title" | "tone">) => string;
  /** Replaces a shown toast's content in place (e.g. progress, or a failure after an action); keeps its onClose. */
  update: (id: string, options: Omit<ToastOptions, "onClose">) => void;
  close: (id: string) => void;
};

const Manager = createContext<ToastApi | null>(null);

function Bridge({ children }: { children: ReactNode }) {
  // The manager object changes identity between renders; keep the API stable so it can sit in effect deps.
  const manager = Toast.useToastManager();
  const latest = useRef(manager);
  latest.current = manager;
  const api = useMemo<ToastApi>(() => {
    const content = ({ title, description, tone = "info", timeout, action }: Omit<ToastOptions, "onClose">) => ({
      title, description, type: tone, timeout: timeout ?? (tone === "error" ? 0 : 5000), priority: tone === "error" ? "high" as const : "low" as const,
      actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
    });
    const show = ({ onClose, ...options }: ToastOptions): string => latest.current.add({ ...content(options), onClose });
    return {
      show,
      error: (message, options = {}) => show({ ...options, title: message, tone: "error" }),
      update: (id, options) => latest.current.update(id, content(options)),
      close: (id) => latest.current.close(id),
    };
  }, []);
  return <Manager.Provider value={api}>{children}</Manager.Provider>;
}

const icons = { success: CircleCheck, info: Info, error: CircleAlert } as const;

function Stack() {
  const { toasts, close } = Toast.useToastManager();
  // The collapsed stack's height (frontmost toast plus an 8 px peek per older one, plus the gap), published on the root so the
  // import task cards sharing this corner sit above it instead of underneath (#388).
  const shown = toasts.filter((toast) => toast.transitionStatus !== "ending" && !toast.limited);
  const stack = shown.length === 0 ? 0 : (shown[0].height ?? 0) + (shown.length - 1) * 8 + 8;
  useEffect(() => {
    document.documentElement.style.setProperty("--k-toast-stack", `${stack}px`);
    return () => { document.documentElement.style.removeProperty("--k-toast-stack"); };
  }, [stack]);
  return toasts.map((toast) => {
    const Icon = icons[(toast.type as ToastTone | undefined) ?? "info"] ?? Info;
    return <Toast.Root key={toast.id} toast={toast} className="k-toast" data-tone={toast.type}>
      {/* Content clips a taller toast to the frontmost one's height while the stack is collapsed. */}
      <Toast.Content className="k-toast-content">
        <span className="k-toast-icon"><Icon size={16} aria-hidden="true" /></span>
        <div className="k-toast-text">
          <Toast.Title className="k-toast-title" />
          <Toast.Description className="k-toast-desc" />
        </div>
        {toast.actionProps && <Toast.Action className="k-toast-action" />}
        {/* Our own close: Base UI's Toast.Close hides itself from assistive tech while the stack is collapsed. */}
        <button type="button" className="k-toast-close" aria-label={toast.type === "error" ? "知道了" : "关闭提示"} title={toast.type === "error" ? "知道了" : "关闭"}
          onClick={() => close(toast.id)}><X size={14} aria-hidden="true" /></button>
      </Toast.Content>
    </Toast.Root>;
  });
}

/**
 * Toast stack (Base UI Toast) replacing the sticky red banners: bottom-right, collapsed behind the newest toast until
 * hovered or focused, auto-dismissing for confirmations, persistent for real errors. Mount once around the window's content.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <Toast.Provider limit={4}>
    <Bridge>{children}</Bridge>
    <Toast.Portal><Toast.Viewport className="k-toasts" aria-label="提示"><Stack /></Toast.Viewport></Toast.Portal>
  </Toast.Provider>;
}

/** Null outside a ToastProvider, so components stay usable on their own (they fall back inline). */
export function useToast(): ToastApi | null {
  return useContext(Manager);
}
