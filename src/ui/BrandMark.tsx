// The keyhole bookmark from the logo kit (design/logo-kit/), the same path the rail has carried since
// the prototype (bd8aea44). A brand invariant: never swap it for a generic icon (design/ui-system/README.md).
export function BrandMark({ size }: { size: number }) {
  return <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <path className="brand-mark" fillRule="evenodd" d="M12 6 H20 A2 2 0 0 1 22 8 V27 L16 22.5 L10 27 V8 A2 2 0 0 1 12 6 Z M14.8 15.75 A3 3 0 1 1 17.2 15.75 L18 19.5 H14 Z" />
  </svg>;
}
