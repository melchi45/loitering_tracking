package ingest

import (
	"fmt"
	"log"
	"net"

	"github.com/pion/rtp"
)

// ForwardRTP reads RTP packets from ch and sends them to mediasoup PlainTransport
// via loopback UDP. No H264 decode — raw RTP forwarding only.
func ForwardRTP(ch <-chan *rtp.Packet, mediasoupPort int, stopCh <-chan struct{}) {
	addr, err := net.ResolveUDPAddr("udp4", fmt.Sprintf("127.0.0.1:%d", mediasoupPort))
	if err != nil {
		log.Printf("[rtp-forward] resolve addr error: %v", err)
		return
	}

	conn, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		log.Printf("[rtp-forward] dial error: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("[rtp-forward] → mediasoup port %d", mediasoupPort)

	buf := make([]byte, 1500)
	for {
		select {
		case <-stopCh:
			return
		case pkt, ok := <-ch:
			if !ok {
				return
			}
			n, err := pkt.MarshalTo(buf)
			if err != nil {
				continue
			}
			if _, err := conn.Write(buf[:n]); err != nil {
				log.Printf("[rtp-forward] write error: %v", err)
			}
		}
	}
}
