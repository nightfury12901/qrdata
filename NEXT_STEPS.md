# NEXT_STEPS.md — Ideas parked for later phases

## Phase 2+
- **Portrait orientation support** on receiver — removed from Phase 1 to 
  reduce variables while validating the homography pipeline.
- **Adaptive threshold** — if Otsu global threshold proves fragile under 
  uneven lighting, switch to a local adaptive threshold (e.g. mean-based 
  or Gaussian-weighted neighborhood).
- **WebGL-accelerated perspective warp** — if the pure-JS homography 
  becomes a bottleneck when grid density increases.
- **Barcode Detection API** — some mobile browsers support native QR/barcode 
  detection; investigate whether it can accelerate anchor finding.
- **Web Workers** — move the decode pipeline off the main thread if UI 
  responsiveness becomes an issue at higher grid densities.
