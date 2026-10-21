import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { reportCaptureReferences } from "../ipc";
import type { CaptureReference } from "../bindings/CaptureReference";
import type { ScreenRect } from "../bindings/ScreenRect";

type Provider = { priority: number; read: () => CaptureReference[] | null };
const providers = new Set<Provider>();
const instance = crypto.randomUUID();
let generation = 0;
let installation = 0;

/**
 * Every element with its rectangle, read once per collection (#216). Each captured image used to walk the whole
 * document and read every rectangle again: with a large wall and sidebar that was tens of thousands of reads per
 * frame, twice per capture. Layout cannot change inside the synchronous collection, so one read serves all images.
 */
type Painted = { node: HTMLElement; rect: DOMRect }[];
let frameNodes: Painted | null = null;
function paintedNodes(): Painted {
  return frameNodes ?? [...document.querySelectorAll<HTMLElement>("body *")].map((node) => ({ node, rect: node.getBoundingClientRect() }));
}
/** Run `read` with the element rectangles read once; `captureImage` calls inside it share them. */
export function readCaptureFrame<T>(read: () => T): T {
  frameNodes = paintedNodes();
  try {
    return read();
  } finally {
    frameNodes = null;
  }
}

/** Read the painted image content, including contain letterboxing, viewport clipping and DOM overlays. */
export function captureImage(image: HTMLImageElement, clip: HTMLElement, libraryId: string, imageId: string, width: number, height: number): CaptureReference | null {
  const style = getComputedStyle(image);
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || style.visibility === "hidden" || style.display === "none" || Number(style.opacity || 1) === 0) return null;
  const box = image.getBoundingClientRect();
  const limit = clip.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || limit.width <= 0 || limit.height <= 0) return null;
  const scale = Math.min(box.width / width, box.height / height);
  const shown = { left: box.left + (box.width - width * scale) / 2, top: box.top + (box.height - height * scale) / 2, right: box.left + (box.width + width * scale) / 2, bottom: box.top + (box.height + height * scale) / 2 };
  const visible = { left: Math.max(shown.left, limit.left, 0), top: Math.max(shown.top, limit.top, 0), right: Math.min(shown.right, limit.right, window.innerWidth), bottom: Math.min(shown.bottom, limit.bottom, window.innerHeight) };
  const dpr = window.devicePixelRatio || 1;
  const physical = (rect: typeof shown, inset = false): ScreenRect => {
    const left = (inset ? Math.ceil : Math.round)(rect.left * dpr);
    const top = (inset ? Math.ceil : Math.round)(rect.top * dpr);
    const right = (inset ? Math.floor : Math.round)(rect.right * dpr);
    const bottom = (inset ? Math.floor : Math.round)(rect.bottom * dpr);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const clipped = physical(visible, true);
  if (!clipped.width || !clipped.height) return null;
  const covered: ScreenRect[] = [];
  // Only painted elements above this image count. Ancestors and transparent layout wrappers do not.
  if (document.elementFromPoint) for (const { node, rect: r } of paintedNodes()) {
    const intersection = { left: Math.max(r.left, visible.left), top: Math.max(r.top, visible.top), right: Math.min(r.right, visible.right), bottom: Math.min(r.bottom, visible.bottom) };
    if (intersection.right <= intersection.left || intersection.bottom <= intersection.top) continue;
    if (node === image || node.contains(image) || image.contains(node)) continue;
    // Only the topmost element matters: elementFromPoint stops there, elementsFromPoint builds the whole stack.
    const top = document.elementFromPoint((intersection.left + intersection.right) / 2, (intersection.top + intersection.bottom) / 2);
    if (top && top !== image && !top.contains(image) && (top === node || node.contains(top))) covered.push(physical(intersection));
  }
  return { libraryId, imageId, shown: physical(shown), visible: clipped, covered };
}

/** The highest priority that answers wins; providers sharing that priority are side-by-side surfaces and merge. */
function collect(all: Provider[]): CaptureReference[] {
  let winner: number | null = null;
  const references: CaptureReference[] = [];
  readCaptureFrame(() => {
    for (const provider of all.sort((a, b) => b.priority - a.priority)) {
      if (winner !== null && provider.priority < winner) break;
      const read = provider.read();
      if (read === null) continue;
      winner = provider.priority;
      references.push(...read);
    }
  });
  return references;
}

/** The native action requests a fresh frame before and after capture. No persistent rectangle cache. */
export function useCaptureSources(read: Provider["read"], priority: number) {
  const current = useRef(read);
  current.current = read;
  useEffect(() => {
    const provider = { priority, read: () => current.current() };
    providers.add(provider);
    if (providers.size === 1) install();
    return () => { providers.delete(provider); if (!providers.size) stop?.(); generation += 1; };
  }, [priority]);
}
let stop: (() => void) | null = null;
function install() {
  const version = ++installation;
  let unlisten: UnlistenFn | null = null;
  let requestGeneration = 0;
  const dirty = () => { generation += 1; };
  const observer = new MutationObserver(dirty);
  observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(dirty);
  resize?.observe(document.documentElement);
  for (const name of ["scroll", "resize", "load", "error", "transitionrun", "transitionend", "animationstart", "animationend"]) window.addEventListener(name, dirty, true);
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
  void listen<{ request: string }>("capture-reference-request", async ({ payload }) => {
    const request = ++requestGeneration;
    // Let committed layout and image paint reach the compositor before the native grab.
    await frame(); await frame();
    if (version !== installation || request !== requestGeneration || !providers.size) return;
    if (observer.takeRecords().length || document.getAnimations?.().some((a) => a.playState === "running" && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.closest(".card,.viewer-stage"))) dirty();
    const references = collect([...providers]);
    await reportCaptureReferences(payload.request, { instance, generation, dpr: window.devicePixelRatio || 1, references }).catch(() => {});
  }).then((off) => { if (version === installation) unlisten = off; else off(); }).catch(() => {});
  stop = () => {
    installation += 1; requestGeneration += 1; unlisten?.(); observer.disconnect(); resize?.disconnect();
    for (const name of ["scroll", "resize", "load", "error", "transitionrun", "transitionend", "animationstart", "animationend"]) window.removeEventListener(name, dirty, true);
    stop = null;
  };
}
