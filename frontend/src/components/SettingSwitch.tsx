import React from "react";

interface SettingSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** Shared, keyboard-accessible on/off switch for admin settings. */
export default function SettingSwitch({ checked, onChange, label, disabled = false }: SettingSwitchProps) {
  return (
    <span className={`flex shrink-0 flex-col items-end gap-1.5 ${disabled ? "opacity-50" : ""}`}>
      <span className="relative inline-flex">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span aria-hidden="true" className="relative h-8 w-14 rounded-full bg-stone-300 shadow-inner transition-colors duration-200 peer-checked:bg-stone-900 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500 peer-focus-visible:ring-offset-4 motion-reduce:transition-none">
          <span className={`absolute left-1 top-1 h-6 w-6 rounded-full shadow-sm transition-transform duration-200 motion-reduce:transition-none ${checked ? "translate-x-6 bg-amber-400" : "translate-x-0 bg-white"}`} />
        </span>
      </span>
      <span aria-hidden="true" className={`text-[10px] font-bold uppercase tracking-wider ${checked ? "text-stone-800" : "text-stone-500"}`}>
        {checked ? "Enabled" : "Disabled"}
      </span>
    </span>
  );
}
