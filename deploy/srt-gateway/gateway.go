package main

// Pure helpers (unit tested in gateway_test.go).

import (
	"errors"
	"regexp"
	"strings"
)

// Ingest paths are exactly "live/<stream key>" (same rule as MediaMTX paths).
var pathRe = regexp.MustCompile(`^live/live_[A-Za-z0-9]{32}$`)

var (
	errBadStreamID = errors.New("bad streamid")
	errNotPublish  = errors.New("only publishing is supported")
)

// ParseStreamID extracts the ingest path from an SRT streamid. Accepted forms:
//
//	publish:live/<key>                 (MediaMTX style, as shown in the studio)
//	publish:live/<key>:user:pass       (credentials are ignored; the key authorises)
//	#!::r=live/<key>,m=publish         (SRT Access Control standard syntax)
//	live/<key> or <key>                (publish implied)
func ParseStreamID(streamID string) (string, error) {
	s := strings.TrimSpace(streamID)
	var path string
	switch {
	case strings.HasPrefix(s, "#!::"):
		mode := "publish"
		for _, kv := range strings.Split(s[4:], ",") {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			switch k {
			case "r":
				path = v
			case "m":
				mode = v
			}
		}
		if mode != "publish" {
			return "", errNotPublish
		}
	case strings.HasPrefix(s, "publish:"):
		path = strings.SplitN(s[len("publish:"):], ":", 2)[0]
	case strings.HasPrefix(s, "read:"):
		return "", errNotPublish
	default:
		path = s
	}
	path = strings.TrimPrefix(path, "/")
	if !strings.HasPrefix(path, "live/") {
		path = "live/" + path
	}
	if !pathRe.MatchString(path) {
		return "", errBadStreamID
	}
	return path, nil
}

// FFmpegArgs builds the remux command: whatever container arrives over SRT
// (MPEG-TS, Matroska/WebM, FLV, NUT…) is probed, and the first video and
// first audio track are re-published to MediaMTX over RTSP without
// re-encoding. RTSP carries AV1, VP9, VP8, H.265 and H.264.
func FFmpegArgs(rtspBase, path string) []string {
	return []string{
		"-hide_banner", "-nostats", "-loglevel", "warning",
		"-fflags", "+genpts+discardcorrupt",
		"-probesize", "10000000", "-analyzeduration", "5000000",
		"-i", "pipe:0",
		"-map", "0:v:0", "-map", "0:a:0?",
		"-c", "copy",
		// FFmpeg flags its AV1 RTP packetizer as experimental (the AOM RTP
		// payload format itself is final; MediaMTX depacketizes it fine).
		"-strict", "experimental",
		"-f", "rtsp", "-rtsp_transport", "tcp",
		// via=srt lets the control plane show the real ingest protocol.
		strings.TrimRight(rtspBase, "/") + "/" + path + "?via=srt",
	}
}
