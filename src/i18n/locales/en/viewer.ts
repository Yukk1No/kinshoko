import type zh from "../zh-CN/viewer";
import type { Translation } from "../../translation";

const viewer: Translation<typeof zh> = {
  label: "Image viewer",
  back: "Back",
  backLabel: "Back to the image wall",
  previous: "Previous",
  previousTitle: "Previous ←",
  next: "Next",
  nextTitle: "Next →",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomLevel: "Zoom level",
  imageAlt: "Reference image being viewed",
  loading: "Loading the reference image…",
  loadFailed: "Couldn't read this reference image. Check that the library files are still accessible.",
  retry: "Try again",
  pinnedPart: "Region pinned",
  pinnedWhole: "Whole image pinned",
  selection: "Selection",
  originalPixels: "Original pixels",
  crop: {
    label: "Region",
    redo: "Reselect",
    cancel: "Cancel",
  },
  tools: {
    label: "Viewer tools",
    fit: "Fit to window",
    crop: "Select a region",
    background: "Background",
    showInspector: "Show details",
    hideInspector: "Hide details",
  },
  ground: {
    dark: "Dark grey",
    mid: "Mid grey",
    light: "Light grey",
    checker: "Checkerboard",
  },
  menu: {
    label: "Viewer menu",
    inspector: "Details",
  },
};

export default viewer;
