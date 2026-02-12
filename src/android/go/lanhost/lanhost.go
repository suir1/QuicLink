package lanhost

// Host is the minimal lifecycle contract for the future Android LAN host core.
type Host struct {
	running bool
}

func NewHost() *Host {
	return &Host{}
}

func (h *Host) Start() error {
	h.running = true
	return nil
}

func (h *Host) Stop() {
	h.running = false
}

func (h *Host) Running() bool {
	return h.running
}
