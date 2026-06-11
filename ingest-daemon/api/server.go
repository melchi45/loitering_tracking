package api

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/lts2026/ingest-daemon/ingest"
)

// Server wraps the camera manager and HTTP router.
type Server struct {
	manager *ingest.Manager
	router  *gin.Engine
}

func NewServer() *Server {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	s := &Server{
		manager: ingest.NewManager(),
		router:  r,
	}
	s.registerRoutes()
	return s
}

func (s *Server) registerRoutes() {
	// POST /cameras — register and start a camera ingest session
	s.router.POST("/cameras", func(c *gin.Context) {
		var cfg ingest.CameraConfig
		if err := c.ShouldBindJSON(&cfg); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if cfg.ID == "" || cfg.RTSPURL == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id and rtspUrl required"})
			return
		}
		if err := s.manager.Add(cfg); err != nil {
			log.Printf("[api] camera %s start error: %v", cfg.ID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		log.Printf("[api] camera %s registered (mediasoupPort=%d)", cfg.ID, cfg.MediasoupPort)
		c.JSON(http.StatusOK, gin.H{"ok": true, "id": cfg.ID})
	})

	// DELETE /cameras/:id — stop and remove a camera ingest session
	s.router.DELETE("/cameras/:id", func(c *gin.Context) {
		id := c.Param("id")
		s.manager.Remove(id)
		log.Printf("[api] camera %s removed", id)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	// GET /cameras — list active camera IDs and count
	s.router.GET("/cameras", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"count": s.manager.Count()})
	})

	// GET /health — liveness probe for Node.js startup check
	s.router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"cameras": s.manager.Count(),
		})
	})
}

func (s *Server) Run(addr string) error {
	return s.router.Run(addr)
}

func (s *Server) StopAll() {
	s.manager.StopAll()
}
