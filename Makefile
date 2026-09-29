# OmniPilot Synapse — extension MVP
#
# All real work happens in apps/extension; these targets are convenience wrappers.

EXT := apps/extension

.PHONY: help install dev build build-firefox icons test test-int test-reg test-smk test-e2e assert-content pack ci \
        deploy deploy-chrome deploy-firefox deploy-verify deploy-dry-run deploy-help clean

help: deploy-help
	@echo "install        install extension dependencies"
	@echo "dev            run WXT dev server (Chrome)"
	@echo "build          build Chrome MV3 bundle"
	@echo "build-firefox  build Firefox bundle"
	@echo "icons          regenerate PNG icons"
	@echo "test           run UNIT suite (vitest)"
	@echo "test-int       run INT suite (vitest)"
	@echo "test-e2e       run Playwright E2E against the built extension"
	@echo "assert-content fail the build if the content bundle leaks secrets"
	@echo "pack           test + build + zip (use ARGS=--skip-test to skip tests)"
	@echo "ci             test + int + build + assert + e2e"
	@echo "clean          remove build output"

install:
	npm --prefix $(EXT) install

dev:
	npm --prefix $(EXT) run dev

build:
	npm --prefix $(EXT) run build

build-firefox:
	npm --prefix $(EXT) run build:firefox

icons:
	npm --prefix $(EXT) run icons

test:
	npm --prefix $(EXT) run test

test-int:
	npm --prefix $(EXT) run test:int

test-reg:
	npm --prefix $(EXT) run test:reg

test-smk:
	npm --prefix $(EXT) run test:smk

test-e2e:
	npm --prefix $(EXT) run test:e2e

assert-content:
	npm --prefix $(EXT) run assert:content

pack:
	npm --prefix $(EXT) run pack -- $(ARGS)

ci:
	npm --prefix $(EXT) run ci

clean:
	rm -rf $(EXT)/.output $(EXT)/.wxt $(EXT)/test-results $(EXT)/playwright-report

# ── One-click delivery ────────────────────────────────────────────────────────
# This project ships a browser extension, so the deploy modes are per-browser
# packaging rather than docker/k8s/binary. See deploy/README.md.

deploy-help:
	@echo "One-click delivery:"
	@echo "  make deploy                 # default: all browsers"
	@echo "  make deploy-chrome | deploy-firefox"
	@echo "  make deploy-verify          # verification only, no packages"
	@echo "  make deploy-dry-run MODE=chrome|firefox|all"
	@echo "  make deploy MODE=<mode> ARGS='--skip-test --build-only'"

deploy:
	@bash deploy/deploy.sh $(or $(MODE),all) $(ARGS)

deploy-chrome:
	@bash deploy/deploy.sh chrome $(ARGS)

deploy-firefox:
	@bash deploy/deploy.sh firefox $(ARGS)

deploy-verify:
	@bash deploy/deploy.sh verify $(ARGS)

deploy-dry-run:
	@bash deploy/deploy.sh $(or $(MODE),all) --dry-run $(ARGS)
