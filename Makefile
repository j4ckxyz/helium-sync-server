VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X helium-sync/internal/server.Version=$(VERSION)
PLATFORMS := linux/amd64 linux/arm64 linux/arm darwin/amd64 darwin/arm64 windows/amd64 windows/arm64 freebsd/amd64

.PHONY: build dist test test-go test-js e2e perf matrix demo

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/helium-sync ./cmd/helium-sync

dist:
	@for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; [ $$os = windows ] && ext=.exe; \
	  [ $$arch = arm ] && export GOARM=7; \
	  echo "building $$os/$$arch"; \
	  GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/helium-sync-$$os-$$arch$$ext ./cmd/helium-sync || exit 1; \
	done

test: test-go test-js

test-go:
	go vet ./...
	go test -race ./...

test-js:
	node --test test/unit/*.test.js

# End-to-end tests drive real browsers: HELIUM=/path/to/helium (or BROWSER=/path/to/chromium).
e2e:
	node --test --test-concurrency=1 test/e2e/sync.test.js test/e2e/lifecycle.test.js

perf:
	HS_PERF=1 node --test --test-concurrency=1 test/e2e/perf.test.js

# Compatibility matrix: make matrix BROWSERS="/path/old/chrome /path/new/chrome"
matrix:
	sh test/e2e/matrix.sh $(BROWSERS)

# README demo media: needs an X display (e.g. Xvfb :77 -screen 0 1600x900x24), ffmpeg and HELIUM.
demo:
	DISPLAY=$${DISPLAY:-:77} node test/demo/record.mjs demo-out
	node test/demo/encode.mjs demo-out assets/demo
