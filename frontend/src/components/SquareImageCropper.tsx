import React, { useCallback, useState } from "react";
import Cropper from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import { X, Check } from "lucide-react";

interface SquareImageCropperProps {
  file: File;
  onCancel: () => void;
  onConfirm: (dataUrl: string, file: File) => void;
  maxDimension?: number;
  quality?: number;
}

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Draw the cropped square region onto a canvas and return a data URL.
function cropCanvas(source: HTMLImageElement, pixelCrop: Area, outputSize = 512, quality = 0.92): string {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    source,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize
  );
  return canvas.toDataURL("image/jpeg", quality);
}

// Resize image to max dimension while maintaining aspect ratio
function resizeImage(source: HTMLImageElement, maxDimension: number, quality: number): string {
  const canvas = document.createElement("canvas");
  let { width, height } = source;
  
  if (width > height) {
    if (width > maxDimension) {
      height = (height * maxDimension) / width;
      width = maxDimension;
    }
  } else {
    if (height > maxDimension) {
      width = (width * maxDimension) / height;
      height = maxDimension;
    }
  }
  
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

export default function SquareImageCropper({ file, onCancel, onConfirm, maxDimension = 1200, quality = 0.85 }: SquareImageCropperProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);

  React.useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setImageSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const onCropComplete = useCallback(
    (_: Area, areaPixels: Area) => setCroppedAreaPixels(areaPixels),
    []
  );

  const handleConfirm = async () => {
    if (!imageSrc || !croppedAreaPixels) return;
    setProcessing(true);
    try {
      const img = new Image();
      img.src = imageSrc;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not load image"));
      });
      
      // First crop to square, then resize if needed
      const croppedDataUrl = cropCanvas(img, croppedAreaPixels, Math.min(maxDimension, 512), quality);
      
      // If the cropped image is still larger than maxDimension, resize it
      const finalImg = new Image();
      finalImg.src = croppedDataUrl;
      await new Promise<void>((resolve, reject) => {
        finalImg.onload = () => resolve();
        finalImg.onerror = () => reject(new Error("Could not load cropped image"));
      });
      
      const finalDataUrl = resizeImage(finalImg, maxDimension, quality);
      onConfirm(finalDataUrl, file);
    } catch (err) {
      console.error("Crop failed", err);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200 bg-stone-50">
          <h3 className="text-sm font-bold text-stone-900">Crop image to a square</h3>
          <button onClick={onCancel} className="text-stone-400 hover:text-stone-700 p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="relative h-80 bg-stone-900">
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1 / 1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          )}
        </div>
        <div className="px-5 py-2">
          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Zoom</label>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            className="w-full accent-amber-600 cursor-pointer"
          />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-stone-200 bg-stone-50">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-xs font-bold text-stone-600 hover:bg-stone-200 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={processing || !croppedAreaPixels}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {processing ? "Processing..." : "Apply Square Crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
