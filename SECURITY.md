# Security

This plugin controls a heat pump, holds cloud credentials, and speaks an
unencrypted LAN protocol the hardware mandates. This document states the threat
model it is built against, the risks accepted as inherent, and how to report a
problem.

## Reporting

Please open a GitHub issue for anything that is already public (a crash, a log
leak you can see). For a genuine vulnerability that is not yet public, contact the
maintainer privately rather than filing a public issue.

## What this plugin trusts

- **Your LAN.** Control and status run over plain HTTP to the indoor unit's WiFi
  adapter, which offers nothing else. Anyone already on your network can, in
  principle, observe or control the unit. This is a property of the Mitsubishi
  adapter, not of this plugin, and cannot be fixed in software. Put the adapter on
  a network you trust; a segregated IoT VLAN is ideal.
- **Homebridge's storage.** `config.json` holds your cloud password in clear text,
  as every Homebridge plugin's config does. `localDevices` secrets, if you declare
  them, are stored the same way. Protect the Homebridge host accordingly.
- **The cloud vendor.** One sign-in per startup goes to Kumo's servers
  (`mesca-prod.kumocloud.com` for Canadian accounts, `app-prod.kumocloud.com` for
  US). A compromise of those servers, or of DNS for them, is outside what this
  plugin can defend against — though it does refuse redirects, so a single
  redirect cannot silently divert your credentials elsewhere (see below).

## What it defends

- **Credential requests never follow redirects** (`redirect: 'error'` on every
  cloud call). A 307/308 cannot re-send your password, refresh token or bearer
  header to a host you never named.
- **Secrets are kept out of logs.** Payloads and error bodies are redacted before
  logging; the LAN token, the cloud password and the cryptoSerial do not appear at
  any log level, debug included. This is pinned by tests and was verified on real
  hardware under `homebridge -D`.
- **Addresses are validated before they become request URLs.** A cloud-supplied or
  config-supplied device address that is not an IPv4 (optionally with a port) is
  dropped, not turned into a signed request against an arbitrary host.
- **Local replies are size-capped** (64 KB), so a hostile or broken LAN peer cannot
  exhaust memory with an unbounded response.
- **The v3 cloud is never contacted on a `"ca"` install** — no login, no polling,
  no fallback. The kill switch is armed by `cloudRegion: "ca"`.

## Known residual hardening (not fixed in code)

The LAN discovery sweep sends a signed status-read probe to each host on your
`/24` until one answers like the adapter. Two consequences, both requiring a
malicious host already on your LAN, neither leaking a secret (the token is a
one-way digest and reads status only):

1. A rogue host that answers the probe shape first can be adopted in place of the
   real adapter, injecting false status into HomeKit and receiving command
   requests (a local-control denial of service).
2. Every swept host sees a replayable status-read token, so it could read the
   unit's status (e.g. room temperature) later.

**Mitigation, if your LAN is not fully trusted:** pin each unit's address with
`localControlIps`. A pinned unit skips the sweep entirely — no probe is broadcast,
and only the address you named is ever contacted:

```json
"localControlIps": { "<deviceSerial>": "192.168.6.11" }
```

These were left as documented trade-offs rather than reworking the discovery path,
which is delicate and field-proven; pinning is the robust answer for an untrusted
network.
