package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func runningAsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// The service runs as LocalSystem, whose own AppData is not a sensible
// place for data: use ProgramData.
func serviceDataDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "helium-sync")
}

type handler struct{ args []string }

func (h handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, h.args) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			cancel()
			if err != nil {
				return true, 1
			}
			return false, 0
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(15 * time.Second):
				}
				return false, 0
			}
		}
	}
}

// runService is entered when the service manager starts the binary; os.Args
// holds the arguments stored at install time ("serve" + flags).
func runService(_ []string) error {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	return svc.Run(serviceName, handler{args: args})
}

func connect() (*mgr.Mgr, error) {
	m, err := mgr.Connect()
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil, errors.New("installing a service needs an administrator: run this from an elevated PowerShell (Run as administrator)")
	}
	return m, err
}

func installService(exe string, args []string, data string) error {
	m, err := connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	logPath := filepath.Join(data, "helium-sync.log")
	args = append(args, "--log-file", logPath)
	if s, err := m.OpenService(serviceName); err == nil {
		s.Control(svc.Stop)
		time.Sleep(time.Second)
		s.Delete()
		s.Close()
		time.Sleep(time.Second)
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName:      "Helium Sync",
		Description:      "Self-hosted, end-to-end encrypted sync server for the Helium browser.",
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true, // start after boot-critical services
	}, args...)
	if err != nil {
		return err
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400)
	if err := s.Start(); err != nil {
		return fmt.Errorf("service installed but did not start: %w", err)
	}
	printServiceHints(logPath)
	fmt.Println("  Allow the port through Windows Defender Firewall if other machines connect to it.")
	return nil
}

func uninstallService() error {
	m, err := connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not installed: %w", err)
	}
	defer s.Close()
	s.Control(svc.Stop)
	if err := s.Delete(); err != nil {
		return err
	}
	fmt.Println("Service removed. Data was kept.")
	return nil
}

func serviceStatus() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("service not installed")
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	names := map[svc.State]string{svc.Stopped: "stopped", svc.StartPending: "starting", svc.StopPending: "stopping", svc.Running: "running"}
	fmt.Println("helium-sync service:", names[st.State])
	return nil
}
