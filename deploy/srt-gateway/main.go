// srt-gateway — universal SRT ingest for StreamHub.
//
// MediaMTX's native SRT listener only understands MPEG-TS with H.264/H.265,
// and AV1/VP9 inside MPEG-TS are not standardised (FFmpeg cannot even read
// them back). This gateway accepts SRT publishers on one UDP port for every
// stream key, authorises them with the control plane, lets FFmpeg detect the
// container (Matroska/WebM, FLV, NUT, MPEG-TS…) and re-publishes the tracks
// unchanged to MediaMTX over RTSP. From there the normal pipeline applies.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	srt "github.com/datarhei/gosrt"
)

type config struct {
	listen      string
	opsAddr     string
	controlURL  string
	secret      string
	rtspBase    string
	ffmpeg      string
	passphrase  string
	latency     time.Duration
	maxSessions int64
	authTimeout time.Duration
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func loadConfig() config {
	latencyMs, _ := strconv.Atoi(env("SRT_LATENCY_MS", "200"))
	maxSessions, _ := strconv.Atoi(env("MAX_SESSIONS", "200"))
	return config{
		listen:      env("LISTEN_ADDR", ":8891"),
		opsAddr:     env("OPS_ADDR", ":9101"),
		controlURL:  env("CONTROL_URL", "http://api:3000"),
		secret:      env("INTERNAL_SECRET", "dev-internal-secret-change-me"),
		rtspBase:    env("INGEST_RTSP_URL", "rtsp://ingest:8554"),
		ffmpeg:      env("FFMPEG_PATH", "ffmpeg"),
		passphrase:  os.Getenv("SRT_PASSPHRASE"),
		latency:     time.Duration(latencyMs) * time.Millisecond,
		maxSessions: int64(maxSessions),
		authTimeout: 3 * time.Second,
	}
}

type gateway struct {
	cfg      config
	log      *slog.Logger
	http     *http.Client
	active   atomic.Int64
	accepted atomic.Int64
	rejected atomic.Int64
	bytesIn  atomic.Int64
	wg       sync.WaitGroup
}

// authorize asks the control plane exactly like MediaMTX does for its own
// listeners, so stream keys, resets and bans behave identically.
func (g *gateway) authorize(ctx context.Context, path, ip string) error {
	body, _ := json.Marshal(map[string]any{
		"action": "publish", "path": path, "protocol": "srt", "ip": ip,
		"user": "", "password": "", "id": nil, "query": "",
	})
	ctx, cancel := context.WithTimeout(ctx, g.cfg.authTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.cfg.controlURL+"/internal/mediamtx/auth", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.cfg.secret)
	res, err := g.http.Do(req)
	if err != nil {
		return fmt.Errorf("control plane unreachable: %w", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("denied (%d)", res.StatusCode)
	}
	return nil
}

func (g *gateway) handle(ctx context.Context, req srt.ConnRequest) {
	ip, _, _ := net.SplitHostPort(req.RemoteAddr().String())
	log := g.log.With("ip", ip)

	path, err := ParseStreamID(req.StreamId())
	if err != nil {
		g.rejected.Add(1)
		log.Info("rejected", "reason", err.Error())
		req.Reject(srt.REJX_BAD_REQUEST)
		return
	}
	if g.active.Load() >= g.cfg.maxSessions {
		g.rejected.Add(1)
		log.Warn("rejected", "reason", "too many sessions")
		req.Reject(srt.REJX_OVERLOAD)
		return
	}
	if req.IsEncrypted() || g.cfg.passphrase != "" {
		if err := req.SetPassphrase(g.cfg.passphrase); err != nil {
			g.rejected.Add(1)
			log.Info("rejected", "reason", "bad passphrase")
			req.Reject(srt.REJ_BADSECRET)
			return
		}
	}
	if err := g.authorize(ctx, path, ip); err != nil {
		g.rejected.Add(1)
		log.Info("rejected", "reason", err.Error())
		req.Reject(srt.REJX_UNAUTHORIZED)
		return
	}
	conn, err := req.Accept()
	if err != nil {
		log.Warn("accept failed", "err", err.Error())
		return
	}
	g.accepted.Add(1)
	g.active.Add(1)
	defer g.active.Add(-1)
	defer conn.Close()

	session := fmt.Sprintf("%08x", req.SocketId())
	log = log.With("session", session)
	log.Info("publisher connected")
	started := time.Now()

	cmd := exec.CommandContext(ctx, g.cfg.ffmpeg, FFmpegArgs(g.cfg.rtspBase, path)...)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 3 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Error("ffmpeg stdin", "err", err.Error())
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	if err := cmd.Start(); err != nil {
		log.Error("ffmpeg start", "err", err.Error())
		return
	}

	// SRT → ffmpeg. Ends when the publisher disconnects (or ffmpeg dies).
	copied := make(chan int64, 1)
	go func() {
		n, _ := io.Copy(countingWriter{w: stdin, total: &g.bytesIn}, conn)
		_ = stdin.Close()
		copied <- n
	}()
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	var exitErr error
	var n int64
	select {
	case n = <-copied: // publisher left: let ffmpeg flush and exit
		exitErr = <-waitErr
	case exitErr = <-waitErr: // ffmpeg failed (bad input, ingest refused…)
		conn.Close()
		n = <-copied
	}
	attrs := []any{"bytes", n, "duration", time.Since(started).Round(time.Second).String()}
	if exitErr != nil && ctx.Err() == nil {
		attrs = append(attrs, "ffmpeg", exitErr.Error(), "stderr", lastLines(stderr.String(), 4))
	}
	log.Info("publisher disconnected", attrs...)
}

func main() {
	cfg := loadConfig()
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("svc", "srt-gateway")

	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		res, err := http.Get("http://127.0.0.1" + cfg.opsAddr + "/healthz")
		if err != nil || res.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

	g := &gateway{cfg: cfg, log: log, http: &http.Client{Timeout: cfg.authTimeout}}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	srtCfg := srt.DefaultConfig()
	srtCfg.ReceiverLatency = cfg.latency
	srtCfg.PeerLatency = cfg.latency
	srtCfg.Passphrase = cfg.passphrase
	srtCfg.EnforcedEncryption = cfg.passphrase != ""
	ln, err := srt.Listen("srt", cfg.listen, srtCfg)
	if err != nil {
		log.Error("listen failed", "err", err.Error())
		os.Exit(1)
	}
	log.Info("listening", "addr", cfg.listen, "ingest", cfg.rtspBase)

	ops := &http.Server{Addr: cfg.opsAddr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			if ctx.Err() != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
			fmt.Fprintf(w, `{"ok":%t,"active":%d}`, ctx.Err() == nil, g.active.Load())
		case "/metrics":
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			fmt.Fprintf(w, "streamhub_srt_gateway_active_sessions %d\n", g.active.Load())
			fmt.Fprintf(w, "streamhub_srt_gateway_accepted_total %d\n", g.accepted.Load())
			fmt.Fprintf(w, "streamhub_srt_gateway_rejected_total %d\n", g.rejected.Load())
			fmt.Fprintf(w, "streamhub_srt_gateway_received_bytes_total %d\n", g.bytesIn.Load())
		default:
			http.NotFound(w, r)
		}
	})}
	go func() { _ = ops.ListenAndServe() }()

	go func() {
		<-ctx.Done()
		log.Info("shutting down")
		ln.Close() // closes every publisher connection → ffmpeg EOF
		_ = ops.Close()
	}()

	for {
		req, err := ln.Accept2()
		if err != nil {
			if errors.Is(err, srt.ErrListenerClosed) {
				break
			}
			log.Warn("accept error", "err", err.Error())
			continue
		}
		g.wg.Add(1)
		go func() {
			defer g.wg.Done()
			g.handle(ctx, req)
		}()
	}
	g.wg.Wait()
}

type countingWriter struct {
	w     io.Writer
	total *atomic.Int64
}

func (c countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.total.Add(int64(n))
	return n, err
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	chunk := p
	if len(chunk) > l.n {
		chunk = chunk[len(chunk)-l.n:]
	}
	l.n -= len(chunk)
	_, _ = l.w.Write(chunk)
	return len(p), nil
}

func lastLines(s string, n int) string {
	lines := bytes.Split(bytes.TrimSpace([]byte(s)), []byte("\n"))
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return string(bytes.Join(lines, []byte(" | ")))
}
