"use client"

import * as React from "react"
import useEmblaCarousel, {
  type EmblaCarouselType as CarouselApi,
  type EmblaOptionsType as CarouselOptions,
} from "embla-carousel-react"

import { cn } from "@/lib/utils"
import { ArrowLeft, ArrowRight } from "lucide-react"

type CarouselContextProps = {
  carouselApi: CarouselApi | undefined
  canScrollPrev: boolean
  canScrollNext: boolean
  scrollPrev: () => void
  scrollNext: () => void
  mainRef: ReturnType<typeof useEmblaCarousel>[0]
  options?: CarouselOptions
  orientation?: "horizontal" | "vertical"
  plugins?: Parameters<typeof useEmblaCarousel>[1]
}

const CarouselContext = React.createContext<CarouselContextProps | null>(null)

function useCarousel() {
  const context = React.useContext(CarouselContext)
  if (!context) {
    throw new Error("useCarousel must be used within a <Carousel />")
  }
  return context
}

type CarouselProps = React.HTMLAttributes<HTMLDivElement> & {
  opts?: CarouselOptions
  orientation?: "horizontal" | "vertical"
  plugins?: Parameters<typeof useEmblaCarousel>[1]
  setApi?: (api: CarouselApi) => void
}

const Carousel = React.forwardRef<HTMLDivElement, CarouselProps>(
  ({ orientation = "horizontal", opts, setApi, plugins, className, children, ...props }, ref) => {
    const [carouselRef, carouselApi] = useEmblaCarousel(
      { ...opts, axis: orientation === "horizontal" ? "x" : "y" },
      plugins
    )
    const [canScrollPrev, setCanScrollPrev] = React.useState(false)
    const [canScrollNext, setCanScrollNext] = React.useState(false)

    const onSelect = React.useCallback((api: CarouselApi) => {
      if (!api) return
      setCanScrollPrev(api.canScrollPrev())
      setCanScrollNext(api.canScrollNext())
    }, [])

    const scrollPrev = React.useCallback(() => carouselApi?.scrollPrev(), [carouselApi])
    const scrollNext = React.useCallback(() => carouselApi?.scrollNext(), [carouselApi])

    React.useEffect(() => {
      if (!carouselApi) return
      onSelect(carouselApi)
      carouselApi.on("reInit", onSelect)
      carouselApi.on("select", onSelect)
      if (setApi) setApi(carouselApi)
      return () => { carouselApi?.off("select", onSelect) }
    }, [carouselApi, onSelect, setApi])

    return (
      <CarouselContext.Provider
        value={{
          carouselApi,
          mainRef: carouselRef,
          opts,
          orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
          scrollPrev, scrollNext, canScrollPrev, canScrollNext,
        }}
      >
        <div ref={ref} className={cn("relative", className)} role="region" aria-roledescription="carousel" {...props}>
          {children}
        </div>
      </CarouselContext.Provider>
    )
  }
)
Carousel.displayName = "Carousel"

const CarouselContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { mainRef, orientation } = useCarousel()
    return (
      <div ref={mainRef} className="overflow-hidden">
        <div
          ref={ref}
          className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className)}
          {...props}
        />
      </div>
    )
  }
)
CarouselContent.displayName = "CarouselContent"

const CarouselItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation } = useCarousel()
    return (
      <div
        ref={ref}
        role="group"
        aria-roledescription="slide"
        className={cn("min-w-0 shrink-0 grow-0 basis-full", orientation === "horizontal" ? "pl-4" : "pt-4", className)}
        {...props}
      />
    )
  }
)
CarouselItem.displayName = "CarouselItem"

const CarouselPrevious = React.forwardRef<HTMLButtonElement, React.HTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => {
    const { scrollPrev, canScrollPrev } = useCarousel();
    return (
      <button
        ref={ref}
        onClick={scrollPrev}
        disabled={!canScrollPrev}
        className={cn(
          "neumorphic-button absolute h-10 w-10 rounded-full flex items-center justify-center",
          "left-2 top-1/2 -translate-y-1/2 sm:left-4 z-10",
          className
        )}
        {...props}
      >
        <ArrowLeft className="h-5 w-5 text-text-color-dark" />
        <span className="sr-only">Previous slide</span>
      </button>
    );
  }
);
CarouselPrevious.displayName = "CarouselPrevious";

const CarouselNext = React.forwardRef<HTMLButtonElement, React.HTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => {
    const { scrollNext, canScrollNext } = useCarousel();
    return (
      <button
        ref={ref}
        onClick={scrollNext}
        disabled={!canScrollNext}
        className={cn(
          "neumorphic-button absolute h-10 w-10 rounded-full flex items-center justify-center",
          "right-2 top-1/2 -translate-y-1/2 sm:right-4 z-10",
          className
        )}
        {...props}
      >
        <ArrowRight className="h-5 w-5 text-text-color-dark" />
        <span className="sr-only">Next slide</span>
      </button>
    );
  }
);
CarouselNext.displayName = "CarouselNext";

export { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext };
