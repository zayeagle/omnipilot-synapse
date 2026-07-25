# Project Context — omnipilot-synapse

## Stack & Layers

- **project_type**: greenfield
- **project_structure**: monorepo (planned)
- **clients**: WeChat Mini Program · Browser Extension
- **backend**: self-hosted API + pluggable storage adapters (planned)
- **frontend**: TBD (mini program + extension toolchains)
- **backend**: TBD

## Dependency Topology

- Storage adapters: Git · self-hosted DB · local filesystem
- Optional AI distill service (explicit user authorization)
- No mandatory official cloud

## Stability Level

- **high** (personal private data; security is P0)

## Notes

- Requirements: `docs/requirements/00-requirements.md`
- Remote: https://github.com/zayeagle/omnipilot-synapse
