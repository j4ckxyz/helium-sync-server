// Command helium-sync is a self-hosted, end-to-end encrypted sync server for
// the Helium browser.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"golang.org/x/crypto/acme/autocert"

	heliumsync "helium-sync"
	"helium-sync/internal/server"
	"helium-sync/internal/store"
)

const usage = `helium-sync — self-hosted, end-to-end encrypted sync for Helium

Usage:
  helium-sync serve   [flags]            run the server
  helium-sync invite  [--uses N] [--ttl 168h]
                                         create an invite code for a new account
  helium-sync users                      list accounts
  helium-sync devices <username>         list an account's devices
  helium-sync revoke  <device-id>        sign a device out
  helium-sync delete-user <username>     delete an account and all its data
  helium-sync service install [serve flags]
                                         run the server in the background at boot
                                         (systemd / launchd / Windows service)
  helium-sync service uninstall|status
  helium-sync version

Every command accepts --data DIR (env HELIUM_SYNC_DATA). The default is a
per-user data directory (shown by "helium-sync serve -h").
Run "helium-sync serve -h" for server flags.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	if runningAsService() {
		// Started by the Windows service manager.
		err = runService(args)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	switch cmd {
	case "serve":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		err = serve(ctx, args)
	case "service":
		err = serviceCmd(args)
	case "invite":
		err = invite(args)
	case "users":
		err = users(args)
	case "devices":
		err = devices(args)
	case "revoke":
		err = revoke(args)
	case "delete-user":
		err = deleteUser(args)
	case "version", "--version", "-v":
		fmt.Println("helium-sync", server.Version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return def
}

func envBool(k string) bool {
	b, _ := strconv.ParseBool(os.Getenv(k))
	return b
}

func dataFlag(fs *flag.FlagSet) *string {
	return fs.String("data", env("HELIUM_SYNC_DATA", defaultDataDir()), "data directory (env HELIUM_SYNC_DATA)")
}

// defaultDataDir is where data lives unless --data says otherwise: a
// per-user application directory, so the server finds its data however it
// is started (terminal, service, scheduled task).
func defaultDataDir() string {
	if fi, err := os.Stat("data"); err == nil && fi.IsDir() {
		if _, err := os.Stat(filepath.Join("data", "helium-sync.db")); err == nil {
			return "data" // an existing ./data from older versions
		}
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "helium-sync")
		}
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "helium-sync")
	default:
		if os.Geteuid() == 0 {
			return "/var/lib/helium-sync"
		}
		if d := os.Getenv("XDG_DATA_HOME"); d != "" {
			return filepath.Join(d, "helium-sync")
		}
		if home != "" {
			return filepath.Join(home, ".local", "share", "helium-sync")
		}
	}
	return "data"
}

func openStore(dir string) (*store.Store, error) {
	return store.Open(filepath.Join(dir, "helium-sync.db"))
}

func serve(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := dataFlag(fs)
	addr := fs.String("addr", env("HELIUM_SYNC_ADDR", ""), "listen address (default 127.0.0.1:8080; :443 with --acme-domain, :8443 with --tls-cert) (env HELIUM_SYNC_ADDR)")
	publicURL := fs.String("public-url", env("HELIUM_SYNC_PUBLIC_URL", ""), "external base URL, e.g. https://sync.example.com (env HELIUM_SYNC_PUBLIC_URL)")
	reg := fs.String("registration", env("HELIUM_SYNC_REGISTRATION", "invite"), "account creation: invite, open or closed (env HELIUM_SYNC_REGISTRATION)")
	tlsCert := fs.String("tls-cert", env("HELIUM_SYNC_TLS_CERT", ""), "TLS certificate file (env HELIUM_SYNC_TLS_CERT)")
	tlsKey := fs.String("tls-key", env("HELIUM_SYNC_TLS_KEY", ""), "TLS key file (env HELIUM_SYNC_TLS_KEY)")
	acmeDomain := fs.String("acme-domain", env("HELIUM_SYNC_ACME_DOMAIN", ""), "obtain a Let's Encrypt certificate for this domain; needs ports 80 and 443 (env HELIUM_SYNC_ACME_DOMAIN)")
	acmeEmail := fs.String("acme-email", env("HELIUM_SYNC_ACME_EMAIL", ""), "contact email for Let's Encrypt (env HELIUM_SYNC_ACME_EMAIL)")
	trustProxy := fs.Bool("trust-proxy", envBool("HELIUM_SYNC_TRUST_PROXY"), "behind a reverse proxy that terminates HTTPS: trust its X-Forwarded-* headers (env HELIUM_SYNC_TRUST_PROXY)")
	insecureHTTP := fs.Bool("insecure-http", envBool("HELIUM_SYNC_INSECURE_HTTP"), "allow plain HTTP beyond localhost; only for a trusted private network such as a LAN or Tailscale (env HELIUM_SYNC_INSECURE_HTTP)")
	quotaMB := fs.Int("quota-mb", envInt("HELIUM_SYNC_QUOTA_MB", 1024), "storage quota per account in MiB, 0 = unlimited (env HELIUM_SYNC_QUOTA_MB)")
	historyDays := fs.Int("history-days", envInt("HELIUM_SYNC_HISTORY_DAYS", 90), "keep synced history for this many days, 0 = forever (env HELIUM_SYNC_HISTORY_DAYS)")
	tombstoneDays := fs.Int("tombstone-days", envInt("HELIUM_SYNC_TOMBSTONE_DAYS", 180), "remember deletions this long; devices offline longer resync from scratch (env HELIUM_SYNC_TOMBSTONE_DAYS)")
	memLimitMB := fs.Int("memory-limit-mb", envInt("HELIUM_SYNC_MEMORY_LIMIT_MB", 64), "soft memory target for the Go runtime, 0 = none (env HELIUM_SYNC_MEMORY_LIMIT_MB; GOMEMLIMIT also works)")
	logFile := fs.String("log-file", env("HELIUM_SYNC_LOG_FILE", ""), "write logs to this file instead of stderr (env HELIUM_SYNC_LOG_FILE)")
	logLevel := fs.String("log-level", env("HELIUM_SYNC_LOG_LEVEL", "info"), "debug, info, warn or error")
	fs.Parse(args)

	var lvl slog.Level
	lvl.UnmarshalText([]byte(*logLevel))
	// A soft limit makes the GC work harder before the heap grows, keeping a
	// background server small; it never fails allocations.
	if os.Getenv("GOMEMLIMIT") == "" && *memLimitMB > 0 {
		debug.SetMemoryLimit(int64(*memLimitMB) << 20)
	}
	var logOut io.Writer = os.Stderr
	if *logFile != "" {
		f, err := openLogFile(*logFile)
		if err != nil {
			return err
		}
		defer f.Close()
		logOut = f
	}
	log := slog.New(slog.NewTextHandler(logOut, &slog.HandlerOptions{Level: lvl}))

	if err := os.MkdirAll(*data, 0o700); err != nil {
		return err
	}
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()

	if *acmeDomain != "" && *publicURL == "" {
		*publicURL = "https://" + *acmeDomain
	}
	tlsOn := *tlsCert != "" || *acmeDomain != ""
	if *addr == "" {
		switch {
		case *acmeDomain != "":
			*addr = ":443"
		case tlsOn:
			*addr = ":8443"
		default:
			*addr = "127.0.0.1:8080" // nothing is exposed unless asked for
		}
	}
	if err := checkExposure(*addr, *publicURL, tlsOn, *trustProxy, *insecureHTTP); err != nil {
		return err
	}
	srv, err := server.New(server.Config{
		PublicURL:        *publicURL,
		DataDir:          *data,
		Registration:     *reg,
		TrustProxy:       *trustProxy,
		QuotaBytes:       int64(*quotaMB) << 20,
		HistoryRetention: time.Duration(*historyDays) * 24 * time.Hour,
		TombstoneTTL:     time.Duration(*tombstoneDays) * 24 * time.Hour,
		ExtensionFS:      heliumsync.Extension(),
		WebFS:            heliumsync.Web(),
		Logger:           log,
	}, st)
	if err != nil {
		return err
	}

	go srv.RunMaintenance(ctx)

	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	var ln net.Listener
	switch {
	case *acmeDomain != "":
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			Cache:      autocert.DirCache(filepath.Join(*data, "acme")),
			HostPolicy: autocert.HostWhitelist(*acmeDomain),
			Email:      *acmeEmail,
		}
		hs.TLSConfig = m.TLSConfig()
		hs.TLSConfig.MinVersion = tls.VersionTLS12
		go func() {
			// HTTP-01 challenges, and redirect everything else to HTTPS.
			if err := http.ListenAndServe(":80", m.HTTPHandler(nil)); err != nil {
				log.Error("acme http listener", "err", err)
			}
		}()
	case *tlsCert != "":
		cert, err := tls.LoadX509KeyPair(*tlsCert, *tlsKey)
		if err != nil {
			return fmt.Errorf("load TLS certificate: %w", err)
		}
		hs.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	ln, err = net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	if hs.TLSConfig != nil {
		ln = tls.NewListener(ln, hs.TLSConfig)
	}

	base := *publicURL
	if base == "" {
		scheme := "http"
		if tlsOn {
			scheme = "https"
		}
		host := *addr
		if strings.HasPrefix(host, ":") {
			host = "localhost" + host
		}
		base = scheme + "://" + host
	}
	log.Info("helium-sync listening", "addr", ln.Addr().String(), "url", base, "version", server.Version, "extension", srv.ExtensionID())
	switch {
	case !isLoopback(*addr) && *insecureHTTP && !tlsOn:
		log.Warn("serving plain HTTP beyond localhost (--insecure-http): only do this on a network you trust, such as a LAN or Tailscale. Data stays end-to-end encrypted, but sign-in tokens could be intercepted.")
	case !isLoopback(*addr) && *trustProxy:
		log.Warn("--trust-proxy: make sure only your reverse proxy can reach " + *addr + ", or clients could spoof their address and dodge rate limits")
	}
	if err := bootstrap(ctx, st, *reg, base, logOut); err != nil {
		return err
	}

	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	srv.Close()
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return hs.Shutdown(sctx)
}

// openLogFile appends to path, starting over (keeping one old copy) once
// it passes 5 MiB, so logs never fill the disk.
func openLogFile(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if fi, err := os.Stat(path); err == nil && fi.Size() > 5<<20 {
		_ = os.Rename(path, path+".1")
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}

// checkExposure refuses configurations that would expose sign-in tokens or
// let clients choose the server's public address.
func checkExposure(addr, publicURL string, tlsOn, trustProxy, insecureHTTP bool) error {
	if publicURL != "" {
		if err := server.ValidPublicURL(publicURL); err != nil {
			return err
		}
	}
	if isLoopback(addr) {
		return nil
	}
	if !tlsOn && !trustProxy && !insecureHTTP {
		return fmt.Errorf(`refusing to serve plain HTTP on %s.
Choose one:
  --acme-domain sync.example.com    automatic HTTPS (Let's Encrypt, ports 80 and 443)
  --tls-cert FILE --tls-key FILE    your own certificate
  --trust-proxy                     behind a reverse proxy that does HTTPS (Caddy, nginx); bind to 127.0.0.1
  --insecure-http                   plain HTTP on a private network you trust (LAN, Tailscale)
or keep the default 127.0.0.1:8080 for local use`, addr)
	}
	if publicURL == "" {
		return errors.New("--public-url is required when listening beyond localhost (e.g. --public-url https://sync.example.com); it is the address devices use and is never taken from requests")
	}
	return nil
}

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// bootstrap prints a fresh single-use invite while the server has no
// accounts, so the first user can sign up without touching the CLI.
func bootstrap(ctx context.Context, st *store.Store, reg, base string, out io.Writer) error {
	n, err := st.CountUsers(ctx)
	if err != nil || n > 0 || reg != "invite" {
		return err
	}
	if err := st.DeleteInvitesByNote(ctx, "bootstrap"); err != nil {
		return err
	}
	code := newInviteCode()
	if err := st.CreateInvite(ctx, code, 1, 7*24*time.Hour, "bootstrap"); err != nil {
		return err
	}
	sh, ps1 := server.TweakCommands(base)
	fmt.Fprintf(out, `
  Helium Sync is ready. No accounts yet.

  Invite code for the first account:  %s

  Connect Helium (quit it first), on each computer:
    macOS / Linux:  %s
    Windows:        %s
  or open %s in a browser.

`, code, sh, ps1, base)
	return nil
}

func newInviteCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O, 1/I
	b := make([]byte, 12)
	rand.Read(b)
	out := make([]byte, 0, 14)
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			out = append(out, '-')
		}
		out = append(out, alphabet[int(c)%len(alphabet)])
	}
	return string(out)
}

func invite(args []string) error {
	fs := flag.NewFlagSet("invite", flag.ExitOnError)
	data := dataFlag(fs)
	uses := fs.Int("uses", 1, "how many accounts the code can create")
	ttl := fs.Duration("ttl", 7*24*time.Hour, "how long the code is valid")
	fs.Parse(args)
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	code := newInviteCode()
	if err := st.CreateInvite(context.Background(), code, *uses, *ttl, ""); err != nil {
		return err
	}
	fmt.Printf("Invite code: %s  (uses: %d, expires: %s)\n", code, *uses, time.Now().Add(*ttl).Format(time.RFC1123))
	return nil
}

func users(args []string) error {
	fs := flag.NewFlagSet("users", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	us, err := st.ListUsers(context.Background())
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tDEVICES\tSTORED\tCREATED")
	for _, u := range us {
		ds, _ := st.ListDevices(context.Background(), u.ID)
		usage, _ := st.Usage(context.Background(), u.ID)
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\n", u.Username, len(ds), human(usage), time.UnixMilli(u.CreatedAt).Format("2006-01-02"))
	}
	return tw.Flush()
}

func devices(args []string) error {
	fs := flag.NewFlagSet("devices", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		return errors.New("usage: helium-sync devices <username>")
	}
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	u, err := st.UserByName(context.Background(), fs.Arg(0))
	if err != nil {
		return fmt.Errorf("user %q: %w", fs.Arg(0), err)
	}
	ds, err := st.ListDevices(context.Background(), u.ID)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tLAST SEEN\tADDED")
	for _, d := range ds {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", d.ID, d.Name, time.UnixMilli(d.LastSeen).Format("2006-01-02 15:04"), time.UnixMilli(d.CreatedAt).Format("2006-01-02"))
	}
	return tw.Flush()
}

func revoke(args []string) error {
	fs := flag.NewFlagSet("revoke", flag.ExitOnError)
	data := dataFlag(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		return errors.New("usage: helium-sync revoke <device-id>")
	}
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	if _, err := st.DeleteDevice(context.Background(), 0, fs.Arg(0)); err != nil {
		return err
	}
	fmt.Println("Device signed out. A running server disconnects it within a minute.")
	return nil
}

func deleteUser(args []string) error {
	fs := flag.NewFlagSet("delete-user", flag.ExitOnError)
	data := dataFlag(fs)
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	fs.Parse(args)
	if fs.NArg() != 1 {
		return errors.New("usage: helium-sync delete-user [--yes] <username>")
	}
	st, err := openStore(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	u, err := st.UserByName(context.Background(), fs.Arg(0))
	if err != nil {
		return fmt.Errorf("user %q: %w", fs.Arg(0), err)
	}
	if !*yes {
		fmt.Printf("Delete %q and all of its synced data? Type the username to confirm: ", u.Username)
		var answer string
		fmt.Scanln(&answer)
		if answer != u.Username {
			return errors.New("aborted")
		}
	}
	if err := st.DeleteUser(context.Background(), u.ID); err != nil {
		return err
	}
	fmt.Println("Deleted.")
	return nil
}

func human(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
