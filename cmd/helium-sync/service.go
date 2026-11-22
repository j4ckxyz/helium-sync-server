package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const serviceName = "helium-sync"

// serviceCmd installs, removes or inspects a background service that runs
// "helium-sync serve" at boot: a systemd unit on Linux, a launchd job on
// macOS and a native service on Windows.
func serviceCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: helium-sync service install [serve flags] | uninstall | status")
	}
	switch args[0] {
	case "install":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		exe, _ = filepath.EvalSymlinks(exe)
		serveArgs, data := withServiceDefaults(args[1:])
		if err := os.MkdirAll(data, 0o700); err != nil {
			return fmt.Errorf("create data directory: %w", err)
		}
		if err := installService(exe, serveArgs, data); err != nil {
			return err
		}
		fmt.Printf("Installed and started the %s service.\n  data: %s\n", serviceName, data)
		return nil
	case "uninstall":
		return uninstallService()
	case "status":
		return serviceStatus()
	}
	return fmt.Errorf("unknown service command %q", args[0])
}

// withServiceDefaults makes the data directory explicit and absolute: a
// service starts in an arbitrary working directory, often as another user.
func withServiceDefaults(args []string) ([]string, string) {
	data := ""
	for i, a := range args {
		switch {
		case a == "--data" || a == "-data":
			if i+1 < len(args) {
				data = args[i+1]
			}
		case strings.HasPrefix(a, "--data=") || strings.HasPrefix(a, "-data="):
			data = a[strings.Index(a, "=")+1:]
		}
	}
	out := append([]string{"serve"}, args...)
	if data == "" {
		data = serviceDataDir()
		out = append(out, "--data", data)
	}
	if abs, err := filepath.Abs(data); err == nil && abs != data {
		for i := range out {
			if out[i] == data {
				out[i] = abs
			}
		}
		data = abs
	}
	return out, data
}

func printServiceHints(logPath string) {
	fmt.Println("  Logs (including the first invite code):", logPath)
	fmt.Println("  Admin commands need the same data directory, e.g.: helium-sync invite --data <dir>")
}
