- CLI: `hub invite-member` now returns a one-time onboarding URL alongside
  the invite code. The URL is printed once to stderr (JSON output carries
  the full response unchanged) and is never written to config or logs —
  the invitee opens it, proves the invited email address, and receives the
  single-use code plus the exact `hub setup` command. The raw-code path
  remains as the fallback for manual enrollment.
