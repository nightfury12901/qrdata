# Phase 3 Report: Robustness and Density

## Overview
Phase 3 successfully scaled the optical data grid to **32x32** (4x the density of Phase 2) and integrated **Reed-Solomon Forward Error Correction (FEC)** to make the transmission robust against localized visual corruption (such as screen glare or momentary blur).

## Implementation Details
- **Grid Density (32x32)**: 
  - Increased the data grid to 32x32, allowing us to transmit 1024 bits (128 bytes) per frame.
  - Adjusted the layout constants (`TOTAL_UNITS = 42`) to maintain the robust 2-unit margin that protects the anchor points from bleeding into the denser data grid.
- **Error Correction Protocol (Reed-Solomon)**:
  - Pulled in a pure-JS port of the ZXing Reed-Solomon codec (`reedsolomon.js`).
  - Allocated **28 bytes** per frame to parity blocks.
  - Leaves **96 bytes** of usable payload per frame (excluding the 3-byte header and 1-byte CRC check).
  - The receiver actively measures and corrects bytes that are misidentified due to camera noise or glare, displaying the "Errors fixed" counter live in the stats panel.

## Predicted Performance
Based on the new frame structure:
- **Throughput**: Assuming ~30 FPS decode rate, 96 payload bytes per frame should yield a theoretical maximum throughput of roughly **2.8 KB/s** (~23 kbps). This is a substantial leap from Phase 2's ~800 B/s.
- **Robustness**: The 28 bytes of parity allow the decoder to recover up to **14 completely corrupted bytes** per frame.

## Conclusion
The jump to a 32x32 grid pushes the resolving limits of standard smartphone cameras. If the receiver successfully decodes this at high FPS, it proves the viability of high-density black-and-white grids. 

---

### Ready for Phase 3 (Color) or Phase 4 (Audio Backchannel)?
We have two exciting paths forward:
1. **Pushing Throughput with Color**: If 32x32 B/W works well, we can multiply our throughput by mapping data to RGB channels (8 colors per cell = 3 bits per cell instead of 1). This would immediately triple the throughput to ~70 kbps.
2. **Phase 4 (Audio Backchannel)**: We can build the ultrasonic Web Audio API backchannel to request specific missing frames rather than relying on endless looping.
