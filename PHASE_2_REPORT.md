# Phase 2 Report: Real Payload and Framing

## Overview
Phase 2 successfully transitioned the project from static pattern detection to a functional optical data transfer protocol. The system can now transmit arbitrary text messages, chunk them into frames, transmit them visually, and reassemble them on the receiver.

## Implementation Details
- **Grid Density**: Expanded to a 16x16 data grid, providing 256 bits (32 bytes) per frame.
- **Framing Protocol**: Implemented a 32-byte frame structure in `protocol.js`:
  - **Header (3 bytes)**: 15-bit Sequence Number, 1-bit EOF flag, 8-bit Payload Length.
  - **Payload (28 bytes)**: Variable length up to 28 bytes.
  - **Footer (1 byte)**: CRC-8 checksum covering the header and payload.
- **Transmission**: `sender.js` chunks a text string into frames, applies the protocol, and cycles the frames continuously at ~30 FPS. Padding bytes are randomized to prevent large solid black/white areas that could interfere with anchor detection.
- **Reassembly**: `receiver.js` maintains a map of received frames, validates the CRC-8, detects the EOF flag, and reassembles the complete message once all expected sequence numbers are collected.

## Measured Performance
Based on the live testing metrics observed on the receiver device:
- **Throughput**: Peaked at **845 B/s** (~6.7 kbps) during optimal framing. This is a solid baseline for a 16x16 grid, though still far from the final target of 100-300 kbps.
- **Packet Loss & Reliability**: 
  - **Detection Rate**: **100.0% (610/610)** grid detected when properly framed.
  - The recent layout adjustments (increasing the quiet zone to 2 units, relaxing aspect ratio tolerances) completely resolved earlier issues with anchors bleeding into the data grid or failing perspective checks.

## Design Decisions & What Broke
- **UI Obstruction**: Initially, a large stats overlay blocked the camera's view of the left anchors, causing the user to pan the phone and break detection. **Fix:** Redesigned the UI to be smaller, transparent, and non-obstructive, adding a clear framing reticle.
- **Blur/Blooming**: LCD bleed caused the 1-unit quiet zone to bridge anchors with data cells, breaking anchor detection. **Fix:** Increased the margin (`TOTAL_UNITS` to 26) to provide a 2-unit buffer.
- **Adaptive vs. Global Thresholding**: Global Otsu thresholding proved sufficient because the randomized data padding prevents pathological histograms (e.g., all black screens).

## Conclusion
Phase 2 is fully complete. The foundational optical link and protocol layers are verified and stable.

---

### Ready for Phase 3: Robustness
The next logical steps involve:
1. **Error Correction**: Implementing Reed-Solomon or parity to recover from partially corrupt frames.
2. **Density Increase**: Scaling the grid up (e.g., 32x32) or adding color (RGB channels) to dramatically increase the throughput closer to the 100 kbps target.
