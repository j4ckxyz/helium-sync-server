//go:build !linux && !darwin && !windows

package main

import "errors"

func runningAsService() bool         { return false }
func runService(args []string) error { return nil }
func serviceDataDir() string         { return defaultDataDir() }

var errNoService = errors.New("service management is not supported on this OS; start \"helium-sync serve\" from your init system")

func installService(string, []string, string) error { return errNoService }
func uninstallService() error                       { return errNoService }
func serviceStatus() error                          { return errNoService }
