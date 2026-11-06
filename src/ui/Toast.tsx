import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("shell");
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
        <button type="button" className="k-toast-close" aria-label={toast.type === "error" ? t("toast.gotIt") : t("toast.dismissLabel")} title={toast.type === "error" ? t("toast.gotIt") : t("toast.dismiss")}
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
  const { t } = useTranslation("shell");
  return <Toast.Provider limit={4}>
    <Bridge>{children}</Bridge>
    <Toast.Portal><Toast.Viewport className="k-toasts" aria-label={t("toast.label")}><Stack /></Toast.Viewport></Toast.Portal>
  </Toast.Provider>;
}

export function useToast(): ToastApi {
  const api = useContext(Manager);
  if (!api) throw new Error("useToast outside a ToastProvider");
  return api;
}

export type PersistentToast = Pick<ToastOptions, "title" | "description" | "tone" | "action">;

/**
 * A notice about something still waiting on the artist: stays until dismissed or until `notice` becomes null, updates in
 * place (including on a language change, since the caller's strings change), and stays away once dismissed.
 * `hidden` only steps aside while the artist is already dealing with it (a dialog above it) and forgets nothing.
 * Without `level`, a dismissal lasts until `notice` next becomes null, so a new occurrence shows again;
 * with `level`, it lasts until the level exceeds the one dismissed.
 */
export function usePersistentToast(notice: PersistentToast | null, { hidden = false, level }: { hidden?: boolean; level?: number } = {}) {
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
  useEffect(() => {
    if (!notice && level === undefined) dismissedAt.current = null;
    if (!notice || hidden || (dismissedAt.current !== null && (level ?? 0) <= dismissedAt.current)) { close(); return; }
    dismissedAt.current = null;
    const { title, description, tone, action } = notice;
    const content = { title, description, tone, timeout: 0,
      action: action && { label: action.label, onClick: () => latest.current.notice?.action?.onClick() } };
    if (shown.current !== null) { toast.update(shown.current, content); return; }
    const id: string = toast.show({ ...content, onClose: () => {
      if (shown.current !== id) return;
      shown.current = null;
      dismissedAt.current = latest.current.level ?? 0;
    } });
    shown.current = id;
  }, [notice === null, notice?.title, notice?.description, notice?.tone, notice?.action?.label, hidden, level]);
  useEffect(() => close, []);
}
