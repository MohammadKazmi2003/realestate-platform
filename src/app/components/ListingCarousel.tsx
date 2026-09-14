'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmblaCarouselType as CarouselApi } from 'embla-carousel';
import { Carousel, CarouselContent, CarouselItem } from '@/components/ui/carousel';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ListingImage } from './ListingImage';

const PLACEHOLDER_SRC = 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image';
/** Visible dots in the sliding window; longer galleries scroll the track. */
const MAX_DOTS = 5;
/** Fixed px width of one dot slot — the track translates in slot steps. */
const DOT_SLOT = 10;

type ListingCarouselProps = {
  images: string[];
  /** Alt-text prefix; the slide number is appended automatically. */
  alt: string;
  /** When set, clicking the photo navigates here. Arrows/dots never navigate. */
  linkHref?: string;
  /** When set (and linkHref is unset), clicking the photo calls this with the
   * slide index — e.g. detail pages open the fullscreen viewer. Drag/swipe
   * gestures are filtered out so they never trigger it. */
  onSlideClick?: (index: number) => void;
  /** Optional per-slide caption shown as a bottom-left label (e.g. photo tags). */
  tags?: Array<string | null | undefined>;
  sizes?: string;
  /** Height of the image frame (cards pass h-48, details pass aspect-video). */
  frameClassName?: string;
  imageClassName?: string;
  className?: string;
  loop?: boolean;
  /** First slide loads eager + high priority; the rest lazy. */
  priorityFirst?: boolean;
  /** Notifies parents (e.g. thumbnail strips) of slide changes. */
  onSelect?: (index: number) => void;
  /** Controlled index (used by detail pages to sync with thumbnails). */
  selectedIndex?: number;
};

/** Circular distance between two slides (loop-aware). */
function slideDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

export function ListingCarousel({
  images,
  alt,
  linkHref,
  onSlideClick,
  tags,
  sizes = '(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw',
  frameClassName = 'h-48',
  imageClassName = 'object-cover group-hover:scale-105 transition-transform duration-300',
  className,
  loop = true,
  priorityFirst = true,
  onSelect,
  selectedIndex: controlledIndex,
}: ListingCarouselProps) {
  const gallery = images.length > 0 ? images : [PLACEHOLDER_SRC];
  const n = gallery.length;
  const multi = n > 1;

  const [api, setApi] = useState<CarouselApi | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [canPrev, setCanPrev] = useState(true);
  const [canNext, setCanNext] = useState(true);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Embla drag ends with a synthetic click on the slide link — suppress it so
  // a swipe never navigates. A real tap (no pointer travel) still follows it.
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const handleSelect = useCallback((embla: CarouselApi) => {
    const idx = embla.selectedScrollSnap();
    setSelected(idx);
    setCanPrev(embla.canScrollPrev());
    setCanNext(embla.canScrollNext());
    onSelectRef.current?.(idx);
  }, []);

  useEffect(() => {
    if (!api) return;
    handleSelect(api);
    api.on('select', handleSelect);
    return () => {
      api.off('select', handleSelect);
    };
  }, [api, handleSelect]);

  // Controlled index (detail-page thumbnails drive the carousel).
  useEffect(() => {
    if (controlledIndex == null || !api || controlledIndex === selected) return;
    api.scrollTo(controlledIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledIndex, api]);

  // Preload the next slide only (not the whole gallery) — cheap lookahead
  // that keeps swiping smooth without extra bandwidth/memory.
  useEffect(() => {
    if (!multi || typeof window === 'undefined') return;
    const next = gallery[(selected + 1) % n];
    if (next && next !== PLACEHOLDER_SRC) {
      const pre = new window.Image();
      pre.src = next;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, multi]);

  const recordDragStart = (e: React.PointerEvent) => {
    suppressClick.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
  };

  const watchDragMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx * dx + dy * dy > 100) suppressClick.current = true;
  };

  const guardSlideClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick.current = false;
    }
  };

  const goTo = (idx: number) => (e: React.MouseEvent) => {
    // Bubble-phase stop: the button's own scroll handler (target phase) runs
    // first, then this prevents a wrapping card <Link> from navigating.
    e.stopPropagation();
    api?.scrollTo(idx);
  };

  const step = (dir: 1 | -1) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dir === 1) api?.scrollNext();
    else api?.scrollPrev();
  };

  // Sliding dot window: a fixed 5-slot viewport with an animated track.
  // Advancing moves the track one slot (old dot exits, new dot enters) while
  // the active dot also travels within the window near the edges.
  const dotStart = n <= MAX_DOTS ? 0 : Math.min(Math.max(selected - 2, 0), n - MAX_DOTS);

  const renderSlide = (src: string, index: number) => {
    const near = slideDistance(index, selected, n) <= 1;
    const tag = tags?.[index] || null;
    const frame = (
      <div className={cn('w-full bg-bg-color relative', frameClassName)}>
        {near ? (
          <ListingImage
            src={src}
            alt={`${alt} — image ${index + 1} of ${n}`}
            fill
            sizes={sizes}
            priority={priorityFirst && index === 0}
            loading={priorityFirst && index === 0 ? 'eager' : 'lazy'}
            className={imageClassName}
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0 animate-pulse bg-shadow-dark/10"
            data-testid="carousel-slide-placeholder"
          />
        )}
        {tag && (
          <div className="absolute top-2 left-2 bg-black/50 text-white px-3 py-1 text-sm font-semibold rounded-xl">
            {tag}
          </div>
        )}
      </div>
    );
    if (linkHref) {
      return (
        <Link href={linkHref} onClickCapture={guardSlideClick} aria-label={`${alt} — view details`}>
          {frame}
        </Link>
      );
    }
    if (onSlideClick) {
      return (
        <div
          role="button"
          tabIndex={0}
          onClickCapture={guardSlideClick}
          onClick={() => onSlideClick(index)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSlideClick(index);
            }
          }}
          className="cursor-pointer"
          aria-label={`${alt} — open image ${index + 1} of ${n}`}
        >
          {frame}
        </div>
      );
    }
    return frame;
  };

  if (!multi) {
    return (
      <div className={cn('relative isolate w-full rounded-2xl overflow-hidden shadow-neumorphic-inset', className)} data-testid="listing-carousel">
        {renderSlide(gallery[0], 0)}
      </div>
    );
  }

  return (
    <div
      // `isolate` keeps the overlay controls (z-10 arrows/dots/counter) in a
      // local stacking context so they can never paint above page chrome
      // (sticky navbar) while scrolling.
      className={cn('group relative isolate', className)}
      onPointerDownCapture={recordDragStart}
      onPointerMoveCapture={watchDragMove}
      data-testid="listing-carousel"
    >
      <Carousel
        opts={{ loop, skipSnaps: false }}
        setApi={setApi}
        className="w-full rounded-2xl overflow-hidden shadow-neumorphic-inset"
      >
        {/* Gapless (ml-0/pl-0 override the ui defaults) so one slide fills the frame. */}
        <CarouselContent className="ml-0">
          {gallery.map((src, index) => (
            <CarouselItem key={`${src}-${index}`} className="pl-0">
              {renderSlide(src, index)}
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
      {/* Invisible side tap zones: tapping left/right navigates without
          precision-aiming at an arrow. They sit above the photo but below
          dots/counter/arrows, and never trigger card navigation (siblings of
          the slide link, plus drag-gesture suppression). */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show previous photo"
        data-testid="carousel-zone-prev"
        onClickCapture={guardSlideClick}
        onClick={step(-1)}
        className="absolute inset-y-0 left-0 z-[5] w-[32%] cursor-pointer"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show next photo"
        data-testid="carousel-zone-next"
        onClickCapture={guardSlideClick}
        onClick={step(1)}
        className="absolute inset-y-0 right-0 z-[5] w-[32%] cursor-pointer"
      />
      {/* Minimal chevrons: bare white arrows, revealed on hover/focus, always
          visible on touch devices. Decorative affordance next to the zones. */}
      {canPrev && (
        <button
          type="button"
          aria-label="Previous image"
          onClickCapture={guardSlideClick}
          onClick={step(-1)}
          className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full p-1 text-white opacity-0 transition-all duration-200 hover:scale-110 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <ChevronLeft className="h-7 w-7 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" strokeWidth={2.5} />
        </button>
      )}
      {canNext && (
        <button
          type="button"
          aria-label="Next image"
          onClickCapture={guardSlideClick}
          onClick={step(1)}
          className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full p-1 text-white opacity-0 transition-all duration-200 hover:scale-110 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <ChevronRight className="h-7 w-7 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" strokeWidth={2.5} />
        </button>
      )}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="pointer-events-auto overflow-hidden rounded-full bg-black/45 px-0.5 py-1 backdrop-blur-[2px]"
          style={{ width: Math.min(n, MAX_DOTS) * DOT_SLOT }}
        >
          <div
            className="flex transition-transform duration-300 ease-out"
            data-testid="carousel-dot-track"
            style={{ transform: `translateX(${-dotStart * DOT_SLOT}px)` }}
          >
            {gallery.map((_, idx) => (
              <div
                key={idx}
                className="flex shrink-0 items-center justify-center"
                style={{ width: DOT_SLOT }}
              >
                <button
                  type="button"
                  onClick={goTo(idx)}
                  aria-label={`Go to image ${idx + 1} of ${n}`}
                  aria-current={idx === selected ? 'true' : undefined}
                  data-testid="carousel-dot"
                  data-active={idx === selected ? 'true' : 'false'}
                  className={cn(
                    'rounded-full transition-all duration-200',
                    idx === selected
                      ? 'h-[7px] w-[7px] bg-white'
                      : 'h-[5px] w-[5px] bg-white/60 hover:bg-white/90'
                  )}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        aria-live="polite"
        data-testid="carousel-count"
        className="absolute bottom-2 right-2 z-10 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white"
        onClick={(e) => e.stopPropagation()}
      >
        {selected + 1} / {n}
      </div>
    </div>
  );
}
