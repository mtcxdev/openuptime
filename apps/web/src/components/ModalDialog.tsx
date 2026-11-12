import React, { useEffect, useRef } from "react";

interface ModalDialogProps {
  open?: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  children: React.ReactNode;
}

/** Native top-layer <dialog> matching MTCX Tools DetailDialog behavior (mobile bottom sheet, desktop centered modal). */
export function ModalDialog({
  open = true,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  size = "md",
  className = "",
  children,
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pointerDownOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open && typeof dialog.showModal === "function") {
        dialog.showModal();
      }
      return () => {
        if (dialog.open && typeof dialog.close === "function") {
          dialog.close();
        }
      };
    } else if (dialog.open && typeof dialog.close === "function") {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={`mtcx-dialog mtcx-dialog-${size}${className ? ` ${className}` : ""}`}
      {...({ closedby: "any" } as Record<string, string>)}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        pointerDownOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pointerDownOnBackdrop.current) {
          onClose();
        }
        pointerDownOnBackdrop.current = false;
      }}
    >
      <div className="modal mtcx-modal-panel" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </dialog>
  );
}
