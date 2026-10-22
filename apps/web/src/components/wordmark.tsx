import clsx from 'clsx';

/**
 * Typeset "era." wordmark (design system rule: until the script logo files exist,
 * set the name in the display face, italic, followed by the brand dot).
 */
export function Wordmark({ size = 'md', tagline, inverse }: { size?: 'sm' | 'md' | 'lg'; tagline?: boolean; inverse?: boolean }) {
  const text = size === 'lg' ? 'text-7xl' : size === 'md' ? 'text-[40px] leading-10' : 'text-[30px] leading-[30px]';
  const dot = size === 'lg' ? 'h-4 w-4' : size === 'md' ? 'h-2 w-2' : 'h-1.5 w-1.5';
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-baseline gap-0.5" aria-label="era.">
        <span aria-hidden className={clsx('font-display font-normal italic', text, inverse ? 'text-white' : 'text-ink')}>
          era
        </span>
        <span aria-hidden className={clsx('inline-block rounded-full', dot, inverse ? 'bg-sun' : 'bg-ink')} />
      </span>
      {tagline && (
        <span className={clsx('text-[10px] leading-[14px] tracking-[0.14em] uppercase', inverse ? 'text-white/75' : 'text-muted')}>
          A new era of hospitality
        </span>
      )}
    </span>
  );
}
