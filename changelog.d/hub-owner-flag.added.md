- Server: `GET /v1/me` now returns `is_hub_owner` — true when the caller's
  principal holds the owner role in at least one circle. Agents learn from
  `hub me` whether they may create circles (`POST /v1/families` while setup
  is locked) instead of discovering it via a 403.
