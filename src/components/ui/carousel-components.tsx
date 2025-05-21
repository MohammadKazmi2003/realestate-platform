'use client';

import * as React from 'react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel';

type CarouselContextType = {
  current: number;
  setCurrent: React.Dispatch<React.SetStateAction<number>>;
};

const CarouselContext = React.createContext<CarouselContextType | undefined>(undefined);

function CarouselProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = React.useState(0);
  return (
    <CarouselContext.Provider value={{ current, setCurrent }}>
      {children}
    </CarouselContext.Provider>
  );
}

export {
  CarouselContext,
  CarouselItem,
  CarouselContent,
  CarouselPrevious,
  CarouselNext,
  CarouselProvider,
};
