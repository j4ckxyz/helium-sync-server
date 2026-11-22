package main

import (
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const launchdLabel = "com.helium-sync.server"

func runningAsService() bool         { return false }
func runService(args []string) error { return nil }

func systemDaemon() bool { return os.Geteuid() == 0 }

func plistPath() string {
	if systemDaemon() {
		return "/Library/LaunchDaemons/" + launchdLabel + ".plist"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func serviceDataDir() string {
	if systemDaemon() {
		return "/Library/Application Support/helium-sync"
	}
	return defaultDataDir()
}

func domain() string {
	if systemDaemon() {
		return "system"
	}
	return "gui/" + strconv.Itoa(os.Getuid())
}

func launchctl(args ...string) error {
	cmd := exec.Command("launchctl", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func installService(exe string, args []string, data string) error {
	logPath := filepath.Join(data, "helium-sync.log")
	var items strings.Builder
	for _, a := range append([]string{exe}, args...) {
		items.WriteString("    <string>" + html.EscapeString(a) + "</string>\n")
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
%s  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HELIUM_SYNC_LOG_FILE</key><string>%s</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, launchdLabel, items.String(), html.EscapeString(logPath), html.EscapeString(logPath))
	path := plistPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = launchctl("bootout", domain()+"/"+launchdLabel) // replace an older install
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return err
	}
	if err := launchctl("bootstrap", domain(), path); err != nil {
		// Older macOS versions only know load.
		if err2 := launchctl("load", "-w", path); err2 != nil {
			return err
		}
	}
	printServiceHints(logPath)
	return nil
}

func uninstallService() error {
	path := plistPath()
	if err := launchctl("bootout", domain()+"/"+launchdLabel); err != nil {
		_ = launchctl("unload", "-w", path)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Println("Service removed. Data was kept.")
	return nil
}

func serviceStatus() error {
	return launchctl("print", domain()+"/"+launchdLabel)
}
