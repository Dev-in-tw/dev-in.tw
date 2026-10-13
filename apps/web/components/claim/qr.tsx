import { encode } from "uqr";

/** QR code（向量）：自己畫成 path，不用 innerHTML */
export function QrCode({
  value,
  className,
  label,
}: {
  value: string;
  className?: string;
  label: string;
}) {
  const { data, size } = encode(value, { border: 1 });
  let d = "";
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#111827" />
    </svg>
  );
}
