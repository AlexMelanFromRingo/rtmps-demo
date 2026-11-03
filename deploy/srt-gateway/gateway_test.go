package main

import (
	"strings"
	"testing"
)

const key = "live_ABCDEFGHJKLMNPQRSTUVWXYZabcdef23"

func TestParseStreamID(t *testing.T) {
	ok := map[string]string{
		"publish:live/" + key:                "live/" + key,
		"publish:live/" + key + ":user:pass": "live/" + key,
		"#!::r=live/" + key + ",m=publish":   "live/" + key,
		"#!::m=publish,r=/live/" + key:       "live/" + key,
		"live/" + key:                        "live/" + key,
		key:                                  "live/" + key,
		"  publish:/live/" + key + "  ":      "live/" + key,
	}
	for in, want := range ok {
		got, err := ParseStreamID(in)
		if err != nil || got != want {
			t.Errorf("ParseStreamID(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{
		"", "publish:", "publish:live/short", "read:live/" + key, "#!::r=live/" + key + ",m=request",
		"publish:live/" + key + "/../x", "publish:other/" + key, "publish:live/live_" + strings.Repeat("!", 32),
	}
	for _, in := range bad {
		if got, err := ParseStreamID(in); err == nil {
			t.Errorf("ParseStreamID(%q) = %q, want error", in, got)
		}
	}
}

func TestFFmpegArgs(t *testing.T) {
	args := FFmpegArgs("rtsp://ingest:8554/", "live/"+key)
	joined := strings.Join(args, " ")
	for _, want := range []string{"-i pipe:0", "-c copy", "-map 0:v:0", "-map 0:a:0?", "-f rtsp", "-rtsp_transport tcp", "-strict experimental"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args missing %q: %s", want, joined)
		}
	}
	if last := args[len(args)-1]; last != "rtsp://ingest:8554/live/"+key+"?via=srt" {
		t.Errorf("output url = %q", last)
	}
	if strings.Contains(joined, "secret") {
		t.Error("output URL must not carry credentials")
	}
}
