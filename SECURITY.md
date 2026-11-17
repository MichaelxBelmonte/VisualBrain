# Security

Visual Brain reads your files, runs terminals and installs its own updates, so security reports matter.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting: **Security › Report a vulnerability** on this repository. Include what an attacker can do, the steps to reproduce and the version (Settings › Updates).

Reports are answered as soon as possible. Fixes ship as a new signed release; installed apps update themselves.

## What is in scope

- The local server (`127.0.0.1` only, Host header checked) and its API
- The update feed: Ed25519 signature, package checksum, install location
- Terminal and agent launching, team tokens, the MCP bridge
- Reading of excluded folders or secret files that should never be read

## Supported versions

Only the latest release receives fixes.
