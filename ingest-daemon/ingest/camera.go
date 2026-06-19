package ingest

import "sync"

// CameraConfig holds everything needed to start ingesting a single camera.
type CameraConfig struct {
	ID              string `json:"id"`
	RTSPURL         string `json:"rtspUrl"`
	MediasoupPort   int    `json:"mediasoupPort"` // mediasoup PlainTransport UDP port
	NodeCallbackURL string `json:"callbackUrl"`   // Node.js JPEG receive endpoint
}

// CameraSession represents a running ingest goroutine set for one camera.
type CameraSession struct {
	Config CameraConfig
	stopCh chan struct{}
}

// Manager holds all active camera sessions.
type Manager struct {
	mu      sync.RWMutex
	cameras map[string]*CameraSession
}

func NewManager() *Manager {
	return &Manager{cameras: make(map[string]*CameraSession)}
}

func (m *Manager) Add(cfg CameraConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.cameras[cfg.ID]; ok {
		close(s.stopCh)
		delete(m.cameras, cfg.ID)
	}

	sess := &CameraSession{Config: cfg, stopCh: make(chan struct{})}
	if err := StartRTSP(sess); err != nil {
		return err
	}
	m.cameras[cfg.ID] = sess
	return nil
}

func (m *Manager) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.cameras[id]; ok {
		close(s.stopCh)
		delete(m.cameras, id)
	}
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.cameras {
		close(s.stopCh)
		delete(m.cameras, id)
	}
}

func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.cameras)
}
