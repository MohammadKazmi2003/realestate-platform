import { galleryDotWindowStart } from '@/lib/map/previewCard';

describe('galleryDotWindowStart — sliding map-card indicator', () => {
  it('shows all dots when the gallery fits the window', () => {
    expect(galleryDotWindowStart(0, 3)).toBe(0);
    expect(galleryDotWindowStart(2, 5)).toBe(0);
  });

  it('slides forward keeping the selection inside the window', () => {
    // 20 photos, window of 5: start pinned until selection passes index 2.
    expect(galleryDotWindowStart(0, 20)).toBe(0);
    expect(galleryDotWindowStart(2, 20)).toBe(0);
    expect(galleryDotWindowStart(3, 20)).toBe(1);
    expect(galleryDotWindowStart(10, 20)).toBe(8);
  });

  it('clamps at the end and resets on loop-back', () => {
    expect(galleryDotWindowStart(18, 20)).toBe(15);
    expect(galleryDotWindowStart(19, 20)).toBe(15);
    expect(galleryDotWindowStart(0, 20)).toBe(0);
  });
});
