Provision a per-account Cloudflare backend with a pinned Wrangler, dynamically
created D1 binding, private generated deployment state and secrets, protected
first-circle bootstrap, and verified deployment URL. Repeat runs preserve the
same resources and keys; CI updates discover an explicitly selected existing
Worker's binding. Remove personal identifiers and manual configuration steps
from deployment instructions. Add correlated, private server/CLI enrollment
diagnostics so response, retry, persistence and verification failures can be
identified without exposing credentials or conversation content.
