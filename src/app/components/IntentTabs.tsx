'use client';

import { cn } from '@/lib/utils';
import type { Intent } from '@/lib/intent';

const OPTIONS: { value: Intent; label: string }[] = [
  { value: 'buy', label: 'Buy' },
  { value: 'rent', label: 'Rent' },
];

export function IntentTabs({
  value,
  onChange,
  className,
}: {
  value: Intent;
  onChange: (v: Intent) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Property intent"
      className={cn('flex gap-1 p-1 rounded-2xl shadow-neumorphic-inset', className)}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => {
            if (value !== opt.value) onChange(opt.value);
          }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2 px-3 rounded-xl transition-all',
            value === opt.value
              ? 'shadow-neumorphic-outset bg-bg-color text-text-color-dark'
              : 'text-text-color-light hover:text-text-color-dark'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
