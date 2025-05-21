"use client"

import * as React from "react"
import { useRef } from "react"
import useEmblaCarousel, { EmblaOptionsType } from "embla-carousel-react"
import {
  CarouselContext,
  CarouselItem,
  CarouselContent,
  CarouselPrevious,
  CarouselNext,
} from "./carousel-components" // assumes these are split, or inline them

import { cn } from "@/lib/utils"

type CarouselProps = {
  opts?: EmblaOptionsType
  className?: string
  children: React.ReactNode
}

const Carousel = ({ opts, className, children }: CarouselProps) => {
  const [emblaRef, emblaApi] = useEmblaCarousel(opts)

  return (
    <CarouselContext.Provider value={{ emblaRef, emblaApi }}>
      <div className={cn("relative", className)} ref={emblaRef}>
        {children}
      </div>
    </CarouselContext.Provider>
  )
}

export {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
}
