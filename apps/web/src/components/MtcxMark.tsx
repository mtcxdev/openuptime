interface MtcxMarkProps {
  size?: number;
  className?: string;
}

/** Official MTCX Tools brand mark rendered from the canonical icon asset. */
export function MtcxMark({ size = 28, className = "" }: MtcxMarkProps) {
  return (
    <img
      src="/icons/logo-128.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={`mtcx-mark${className ? ` ${className}` : ""}`}
    />
  );
}
