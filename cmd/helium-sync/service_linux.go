package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func runningAsService() bool         { return false }
func runService(args []string) error { return nil }

func systemUnit() bool { return os.Geteuid() == 0 }

func unitPath() string {
	if systemUnit() {
		return "/etc/systemd/system/" + serviceName + ".service"
	}
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if cfg == "" {
		home, _ := os.UserHomeDir()
		cfg = filepath.Join(home, ".config")
	}
	return filepath.Join(cfg, "systemd", "user", serviceName+".service")
}

func serviceDataDir() string {
	if systemUnit() {
		return "/var/lib/helium-sync"
	}
	return defaultDataDir()
}

func systemctl(args ...string) error {
	if !systemUnit() {
		args = append([]string{"--user"}, args...)
	}
	cmd := exec.Command("systemctl", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func quoteArgs(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		if strings.ContainsAny(a, " \t\"'\\") {
			a = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(a) + `"`
		}
		q[i] = a
	}
	return strings.Join(q, " ")
}

func installService(exe string, args []string, data string) error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return fmt.Errorf("systemd not found; run %q from your init system instead", exe+" "+quoteArgs(args))
	}
	unit := fmt.Sprintf(`[Unit]
Description=Helium Sync server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s %s
Restart=on-failure
RestartSec=5
# Background priority: never compete with interactive use.
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
`, exe, quoteArgs(args))
	if systemUnit() {
		// Sandboxing needs a system unit (user units cannot set up mount
		// namespaces on every distribution).
		unit += fmt.Sprintf("PrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=%s\n\n[Install]\nWantedBy=multi-user.target\n", data)
	} else {
		unit += "\n[Install]\nWantedBy=default.target\n"
	}
	path := unitPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
		return err
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	if err := systemctl("enable", "--now", serviceName); err != nil {
		return err
	}
	if systemUnit() {
		printServiceHints("journalctl -u " + serviceName)
	} else {
		printServiceHints("journalctl --user -u " + serviceName)
		fmt.Println("  To keep it running while you are logged out: loginctl enable-linger", os.Getenv("USER"))
	}
	return nil
}

func uninstallService() error {
	_ = systemctl("disable", "--now", serviceName)
	if err := os.Remove(unitPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = systemctl("daemon-reload")
	fmt.Println("Service removed. Data was kept.")
	return nil
}

func serviceStatus() error {
	return systemctl("status", "--no-pager", serviceName)
}
