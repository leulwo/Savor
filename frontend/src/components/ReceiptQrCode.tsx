import { useEffect, useRef } from 'react';
import { toCanvas } from 'qrcode';

/** Generate the receipt QR locally; customer details never reach an image service. */
export default function ReceiptQrCode({ value }: { value: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    void toCanvas(canvas.current, value, {
      width: 120,
      margin: 4,
      color: { dark: '#1c1917', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    }).catch(() => { /* The visible receipt remains available if QR rendering fails. */ });
  }, [value]);
  return <canvas ref={canvas} role="img" aria-label="Order details QR code" className="w-28 h-28" />;
}
