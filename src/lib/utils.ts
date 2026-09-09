// Basic cn helper compatible with new-admin design (no tailwind-merge/clsx deps).
// Keeps neumorphic UI working with the updated dependency set.
export function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ');
}
