import { fireEvent, render, screen } from '@testing-library/react';
import { ListingCarousel } from '@/app/components/ListingCarousel';

// Functional Embla stub: no layout engine in jsdom, but selection state,
// scroll fns and the 'select' subscription behave like the real hook so slide
// changes (counter, lazy window, dot track) can be exercised.
let mockIdx = 0;
let selectHandler: ((api: any) => void) | null = null;
const mockApi = {
  selectedScrollSnap: () => mockIdx,
  canScrollPrev: () => true,
  canScrollNext: () => true,
  on: jest.fn((evt: string, cb: any) => {
    if (evt === 'select') selectHandler = cb;
  }),
  off: jest.fn(),
  scrollTo: jest.fn((i: number) => {
    mockIdx = i;
    selectHandler?.(mockApi);
  }),
  scrollPrev: jest.fn(() => {
    mockIdx = (mockIdx - 1 + 1000) % 1000;
    selectHandler?.(mockApi);
  }),
  scrollNext: jest.fn(() => {
    mockIdx = (mockIdx + 1) % 1000;
    selectHandler?.(mockApi);
  }),
};
jest.mock('embla-carousel-react', () => ({
  __esModule: true,
  default: () => [jest.fn(), mockApi],
}));

beforeEach(() => {
  mockIdx = 0;
  selectHandler = null;
});

const imgs = (n: number) => Array.from({ length: n }, (_, i) => `https://placehold.co/600x400/DEE4ED/3D4A5C?text=Img${i}`);

describe('ListingCarousel', () => {
  it('renders a single image with no dots or counter', () => {
    render(<ListingCarousel images={imgs(1)} alt="Villa" />);
    expect(screen.getByAltText('Villa — image 1 of 1')).toBeInTheDocument();
    expect(screen.queryByTestId('carousel-dot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('carousel-count')).not.toBeInTheDocument();
  });

  it('renders dots + counter for a 5-photo gallery', () => {
    render(<ListingCarousel images={imgs(5)} alt="Villa" />);
    expect(screen.getAllByTestId('carousel-dot')).toHaveLength(5);
    expect(screen.getByTestId('carousel-count')).toHaveTextContent('1 / 5');
  });

  it('mounts only the current ± 1 window (loop-aware) for distant slides', () => {
    // Selected = 0, n = 5 → near slides are 0, 1 and 4 (loop wrap); 2 and 3
    // render shimmer placeholders instead of downloading.
    render(<ListingCarousel images={imgs(5)} alt="Villa" />);
    expect(screen.getByAltText('Villa — image 1 of 5')).toBeInTheDocument();
    expect(screen.getByAltText('Villa — image 2 of 5')).toBeInTheDocument();
    expect(screen.getByAltText('Villa — image 5 of 5')).toBeInTheDocument();
    expect(screen.queryByAltText('Villa — image 3 of 5')).not.toBeInTheDocument();
    expect(screen.queryByAltText('Villa — image 4 of 5')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('carousel-slide-placeholder')).toHaveLength(2);
  });

  it('renders a 5-slot sliding viewport with a full counter for long galleries', () => {
    const { container } = render(<ListingCarousel images={imgs(20)} alt="Villa" />);
    // All 20 dots ride an animated track; the pill viewport shows 5 slots.
    expect(screen.getAllByTestId('carousel-dot')).toHaveLength(20);
    expect(screen.getByTestId('carousel-count')).toHaveTextContent('1 / 20');
    const viewport = container.querySelector('[data-testid="listing-carousel"] .overflow-hidden.rounded-full');
    expect(viewport).not.toBeNull();
    expect(viewport as HTMLElement).toHaveStyle({ width: '50px' });
  });

  it('renders the placeholder when the gallery is empty', () => {
    render(<ListingCarousel images={[]} alt="Villa" />);
    expect(screen.getByAltText('Villa — image 1 of 1')).toBeInTheDocument();
    expect(screen.queryByTestId('carousel-dot')).not.toBeInTheDocument();
  });

  it('links the photo to the detail page when linkHref is set', () => {
    render(<ListingCarousel images={imgs(2)} alt="Villa" linkHref="/property/p1" />);
    const links = screen.getAllByRole('link', { name: 'Villa — view details' });
    // Both near slides (current ± 1) mount a link; distant ones don't.
    expect(links).toHaveLength(2);
    links.forEach((link) => expect(link).toHaveAttribute('href', '/property/p1'));
  });

  it('renders side tap zones and minimal arrows for multi-photo galleries', () => {
    render(<ListingCarousel images={imgs(3)} alt="Villa" />);
    expect(screen.getByTestId('carousel-zone-prev')).toHaveAttribute('aria-label', 'Show previous photo');
    expect(screen.getByTestId('carousel-zone-next')).toHaveAttribute('aria-label', 'Show next photo');
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeInTheDocument();
  });

  it('renders no zones or arrows for a single photo', () => {
    render(<ListingCarousel images={imgs(1)} alt="Villa" />);
    expect(screen.queryByTestId('carousel-zone-prev')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
  });

  it('slides the dot track as selection advances through a long gallery', () => {
    const { container } = render(<ListingCarousel images={imgs(20)} alt="Villa" />);
    const track = () =>
      container.querySelector('[data-testid="carousel-dot-track"]') as HTMLElement;
    expect(track().style.transform).toBe('translateX(0px)');
    fireEvent.click(screen.getByTestId('carousel-zone-next')); // → 2/20
    fireEvent.click(screen.getByTestId('carousel-zone-next')); // → 3/20
    expect(track().style.transform).toBe('translateX(0px)');
    fireEvent.click(screen.getByTestId('carousel-zone-next')); // → 4/20, window slides
    expect(screen.getByTestId('carousel-count')).toHaveTextContent('4 / 20');
    expect(track().style.transform).toBe('translateX(-10px)');
    const active = container.querySelectorAll('[data-testid="carousel-dot"][data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('aria-label', 'Go to image 4 of 20');
  });
});
