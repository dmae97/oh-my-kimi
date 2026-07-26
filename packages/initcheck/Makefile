GO ?= go
GOOS ?= $(shell $(GO) env GOOS)
GOARCH ?= $(shell $(GO) env GOARCH)
VERSION ?= dev
DIST ?= dist
AGENT_ROOT ?= $(HOME)/.omk/agent
BINARY := $(DIST)/omk-initcheck-$(GOOS)-$(GOARCH)
GHIDRA_BINARY := $(BINARY)-ghidra
PACKAGE := ./cmd/omk-initcheck

.PHONY: test fuzz build ghidra install cross verify-ghidra clean

test:
	$(GO) test -race -shuffle=on -count=1 ./...

fuzz:
	$(GO) test -run '^$$' -fuzz FuzzParseModelsNeverPanics -fuzztime 5s .
	$(GO) test -run '^$$' -fuzz FuzzBuildProbeURLNeverRetainsCredentials -fuzztime 5s .

build:
	mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build \
		-trimpath -buildvcs=false -ldflags "-X main.version=$(VERSION)" \
		-o $(BINARY) $(PACKAGE)

ghidra:
	mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build \
		-buildvcs=false -gcflags 'all=-N -l' -ldflags "-X main.version=$(VERSION)" \
		-o $(GHIDRA_BINARY) $(PACKAGE)

install: build
	install -d -m 0755 $(AGENT_ROOT)/skills/omk-init/bin
	install -m 0755 $(BINARY) $(AGENT_ROOT)/skills/omk-init/bin/$(notdir $(BINARY))

cross:
	@set -eu; for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do \
		os=$${target%/*}; arch=$${target#*/}; suffix=""; \
		[ "$$os" != windows ] || suffix=.exe; \
		$(MAKE) build GOOS=$$os GOARCH=$$arch BINARY=$(DIST)/omk-initcheck-$$os-$$arch$$suffix; \
	done

verify-ghidra: ghidra
	file $(GHIDRA_BINARY)
	readelf -S $(GHIDRA_BINARY) | grep -E '\.debug_(info|line|frame)'
	$(GO) tool nm $(GHIDRA_BINARY) | grep -E 'initcheck\.(BuildProbeURL|ProbeModels)|main\.runModels'

clean:
	rm -rf $(DIST)
