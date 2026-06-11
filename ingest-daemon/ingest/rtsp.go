package ingest

import (
	"fmt"
	"log"

	"github.com/bluenviron/gortsplib/v4"
	"github.com/bluenviron/gortsplib/v4/pkg/base"
	"github.com/bluenviron/gortsplib/v4/pkg/format"
	"github.com/pion/rtp"
)

// StartRTSP connects to the camera RTSP URL and launches fan-out goroutines.
// One RTSP connection per camera — multiple goroutines consume from internal channels.
func StartRTSP(sess *CameraSession) error {
	cfg := sess.Config

	client := &gortsplib.Client{}

	u, err := base.ParseURL(cfg.RTSPURL)
	if err != nil {
		return fmt.Errorf("invalid RTSP URL %s: %w", cfg.RTSPURL, err)
	}

	if err := client.Start(u.Scheme, u.Host); err != nil {
		return fmt.Errorf("RTSP start failed: %w", err)
	}

	desc, _, err := client.Describe(u)
	if err != nil {
		client.Close()
		return fmt.Errorf("RTSP describe failed: %w", err)
	}

	var h264Format *format.H264
	medi := desc.FindFormat(&h264Format)
	if medi == nil {
		client.Close()
		return fmt.Errorf("camera %s has no H264 track", cfg.ID)
	}

	if _, err := client.Setup(desc.BaseURL, medi, 0, 0); err != nil {
		client.Close()
		return fmt.Errorf("RTSP setup failed: %w", err)
	}

	// Buffered channels — WebRTC path is time-critical, AI path can drop frames.
	webrtcCh := make(chan *rtp.Packet, 120)
	aiCh     := make(chan *rtp.Packet, 10)

	// Single RTP callback → non-blocking fan-out to both channels.
	client.OnPacketRTP(medi, h264Format, func(pkt *rtp.Packet) {
		clone := pkt.Clone()
		select {
		case webrtcCh <- clone:
		default:
			// Drop WebRTC packet only if mediasoup is not keeping up.
		}
		aiClone := pkt.Clone()
		select {
		case aiCh <- aiClone:
		default:
			// AI path drops frames gracefully (10 FPS target).
		}
	})

	if _, err := client.Play(nil); err != nil {
		client.Close()
		return fmt.Errorf("RTSP play failed: %w", err)
	}

	log.Printf("[ingest] camera %s connected → %s", cfg.ID, cfg.RTSPURL)

	// WebRTC goroutine: forward raw RTP → mediasoup PlainTransport UDP port.
	go func() {
		ForwardRTP(webrtcCh, cfg.MediasoupPort, sess.stopCh)
	}()

	// AI goroutine: decode H264 → JPEG → HTTP POST to Node.js.
	go func() {
		DecodeAndPush(aiCh, cfg.NodeCallbackURL, sess.stopCh)
	}()

	// Lifecycle goroutine: close RTSP client when session is stopped.
	go func() {
		<-sess.stopCh
		client.Close()
		log.Printf("[ingest] camera %s stopped", cfg.ID)
	}()

	return nil
}
