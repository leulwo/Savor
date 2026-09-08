/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Savory Restaurant
 */

import React, { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import SquareImageCropper from "./SquareImageCropper";
import { toastError } from "../notify";

interface ImageUploadFieldProps {
  value?: string;
  onChange: (dataUrl: string) => void;
  label?: string;
  accept?: string;
  maxSizeMB?: number;
  className?: string;
}

export default function ImageUploadField({
  value,
  onChange,
  label = "Image",
  accept = "image/*",
  maxSizeMB = 4,
  className = ""
}: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toastError("Please choose an image file.");
      return;
    }
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > maxSizeMB) {
      toastError(`Image is too large. Max ${maxSizeMB}MB allowed.`);
      return;
    }
    setPendingFile(file);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0] || null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files?.[0] || null);
  };

  return (
    <div className={className}>
      {label && (
        <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">
          {label}
        </label>
      )}
      <div className="flex items-start space-x-4">
        <div className="w-20 h-20 rounded-2xl border border-stone-200 overflow-hidden shrink-0 flex items-center justify-center bg-stone-50">
          {value ? (
            <img src={value} alt="Preview" className="w-full h-full object-cover" />
          ) : (
            <Upload className="w-5 h-5 text-stone-300" />
          )}
        </div>

        <div className="flex-1 flex flex-col space-y-2">
          <label
            onDragOver={e => e.preventDefault()}
            onDrop={onDrop}
            className="flex flex-col items-center justify-center text-center px-4 py-3 border-2 border-dashed border-stone-300 rounded-xl cursor-pointer hover:border-amber-500 hover:bg-amber-50/30 transition-colors"
          >
            <span className="text-[10px] font-bold text-stone-700 uppercase tracking-wide">
              {value ? "Replace image" : "Click to upload or drag & drop"}
            </span>
            <span className="text-[9px] text-stone-400 mt-1">
              Crop to a square · Max {maxSizeMB}MB
            </span>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              onChange={onPick}
              className="hidden"
            />
          </label>

          {value && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="self-start flex items-center space-x-1 text-[10px] font-bold text-rose-600 hover:text-rose-700 uppercase tracking-wide cursor-pointer"
            >
              <X className="w-3 h-3" />
              <span>Remove</span>
            </button>
          )}
        </div>
      </div>

      {pendingFile && (
        <SquareImageCropper
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onConfirm={(dataUrl) => {
            onChange(dataUrl);
            setPendingFile(null);
          }}
        />
      )}
    </div>
  );
}
