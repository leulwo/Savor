import React, { useEffect, useState, useRef } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

interface ConfirmState {
  message: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmLabel: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let toasts: ToastItem[] = [];
let confirmState: ConfirmState | null = null;
let nextId = 1;

function emit() {
  listeners.forEach(l => l());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return { toasts, confirm: confirmState };
}

function showToast(type: ToastType, message: string, duration = 4000) {
  const id = nextId++;
  toasts = [...toasts, { id, type, message, duration }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    emit();
  }, duration);
}

export function toast(message: string, type: ToastType = "info", duration?: number) {
  showToast(type, message, duration);
}

export function toastSuccess(message: string) {
  showToast("success", message);
}

export function toastError(message: string) {
  showToast("error", message);
}

export function toastInfo(message: string) {
  showToast("info", message);
}

export function toastWarning(message: string) {
  showToast("warning", message);
}

export function confirmDialog(message: string, onConfirm?: () => void, onCancel?: () => void, confirmLabel = "Confirm") {
  confirmState = { message, onConfirm, onCancel, confirmLabel };
  emit();
}

export function closeConfirmDialog() {
  confirmState = null;
  emit();
}

const ICONS: Record<ToastType, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  error: CircleX,
  info: Info,
  warning: TriangleAlert
};

const STYLES: Record<ToastType, string> = {
  success: "bg-emerald-900 text-emerald-50",
  error: "bg-rose-900 text-rose-50",
  info: "bg-stone-900 text-white",
  warning: "bg-amber-700 text-white"
};

export function NotifyHost() {
  const [state, setState] = useState(getSnapshot());
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [swipingId, setSwipingId] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState<Record<number, number>>({});

  useEffect(() => subscribe(() => setState(getSnapshot())), []);

  const handleToastTouchStart = (e: React.TouchEvent, id: number) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    setSwipingId(id);
  };

  const handleToastTouchMove = (e: React.TouchEvent, toastId: number) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      setDragOffset(prev => ({ ...prev, [toastId]: deltaX }));
    }
  };

  const handleToastTouchEnd = (toastId: number) => {
    const currentOffset = dragOffset[toastId] || 0;
    if (Math.abs(currentOffset) > 80) {
      toasts = toasts.filter(x => x.id !== toastId);
      emit();
    }
    setDragOffset(prev => {
      const next = { ...prev };
      delete next[toastId];
      return next;
    });
    setSwipingId(null);
    touchStartRef.current = null;
  };

  return (
    <>
      <div className="fixed top-4 left-4 right-4 sm:left-auto sm:w-full sm:max-w-sm z-[9999] flex flex-col gap-2 pointer-events-none" aria-live="polite" aria-atomic="false">
        {state.toasts.map(t => {
          const offset = dragOffset[t.id] || 0;
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              onTouchStart={(e) => handleToastTouchStart(e, t.id)}
              onTouchMove={(e) => handleToastTouchMove(e, t.id)}
              onTouchEnd={() => handleToastTouchEnd(t.id)}
              style={{
                transform: `translateX(${offset}px)`,
                transition: swipingId === t.id ? 'none' : 'transform 0.2s ease-out',
                opacity: Math.max(0.2, 1 - Math.abs(offset) / 200)
              }}
              className={`${STYLES[t.type]} pointer-events-auto flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-xl shadow-lg text-sm font-medium backdrop-blur-xs animate-[fadeInDown_.2s_ease-out] select-none cursor-grab active:cursor-grabbing`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">{t.message}</span>
              <button
                onClick={() => {
                  toasts = toasts.filter(x => x.id !== t.id);
                  emit();
                }}
                className="ml-2 grid h-8 w-8 place-items-center opacity-60 hover:opacity-100 cursor-pointer flex-shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
      {state.confirm && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 animate-[fadeInDown_.15s_ease-out]">
            <h3 className="font-serif font-bold text-stone-900 text-lg mb-2">Please confirm</h3>
            <p className="text-sm text-stone-600 mb-6 whitespace-pre-line">{state.confirm.message}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  const c = confirmState;
                  confirmState = null;
                  emit();
                  c?.onCancel?.();
                }}
                className="px-4 py-2 text-sm font-semibold text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const c = confirmState;
                  confirmState = null;
                  emit();
                  c?.onConfirm?.();
                }}
                className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer transition-colors"
              >
                {state.confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
