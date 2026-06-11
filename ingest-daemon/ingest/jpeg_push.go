package ingest

import (
	"bytes"
	"image/jpeg"
	"log"
	"net/http"
	"time"

	"github.com/bluenviron/gortsplib/v4/pkg/format/rtph264"
	"github.com/pion/rtp"
)

const (
	aiTargetFPS  = 10
	aiFrameEvery = 3 // ~30fps input → every 3rd frame sent to AI
)

// DecodeAndPush receives H264 RTP packets, decodes every Nth frame to JPEG,
// and HTTP POSTs the JPEG to Node.js for AI inference.
//
// H264 decode strategy:
//   - gortsplib rtph264.Decoder reassembles NAL units from RTP
//   - Then we need a H264 → YUV decoder.
//
// If libav (CGO) is available: use github.com/3d0c/gmf for hardware-accelerated decode.
// If CGO is not available:     stub implementation — extend with your preferred decoder.
func DecodeAndPush(ch <-chan *rtp.Packet, callbackURL string, stopCh <-chan struct{}) {
	decoder := &rtph264.Decoder{}
	decoder.Init()

	httpClient := &http.Client{Timeout: 2 * time.Second}
	frameCount := 0

	for {
		select {
		case <-stopCh:
			return
		case pkt, ok := <-ch:
			if !ok {
				return
			}
			frameCount++
			if frameCount%aiFrameEvery != 0 {
				continue
			}

			// Reassemble H264 NAL units from RTP fragmentation.
			nalUnits, _, err := decoder.Decode(pkt)
			if err != nil || len(nalUnits) == 0 {
				continue
			}

			// ── H264 → JPEG ──────────────────────────────────────────────────
			// Replace decodeNALToJPEG with your chosen decoder:
			//   Option A (CGO + libav): github.com/3d0c/gmf
			//   Option B (CGO + openh264): github.com/gen2brain/x264
			//   Option C (pure Go, limited): github.com/jwhited/codec
			jpegData, err := decodeNALToJPEG(nalUnits)
			if err != nil || len(jpegData) == 0 {
				continue
			}

			// HTTP POST JPEG to Node.js /api/internal/frame/:cameraId
			resp, err := httpClient.Post(callbackURL, "image/jpeg", bytes.NewReader(jpegData))
			if err != nil {
				log.Printf("[jpeg-push] callback error: %v", err)
				continue
			}
			resp.Body.Close()
		}
	}
}

// decodeNALToJPEG converts H264 NAL units to JPEG bytes.
// This stub uses a placeholder image — replace with a real H264 decoder.
//
// Production implementation with github.com/3d0c/gmf (CGO + libav):
//
//	func decodeNALToJPEG(nalUnits [][]byte) ([]byte, error) {
//	    ctx := gmf.NewCodecCtx(gmf.FindDecoder("h264"))
//	    // ... avcodec_send_packet / avcodec_receive_frame / sws_scale to RGB / jpeg.Encode
//	}
func decodeNALToJPEG(nalUnits [][]byte) ([]byte, error) {
	// TODO: replace with real H264 decoder (gmf / openh264 / etc.)
	// Stub: return empty to signal "no frame yet"
	_ = nalUnits
	_ = jpeg.DefaultQuality
	return nil, nil
}
