# Deploying protocol 2

Follow [INSTALL.md](INSTALL.md) and the [coordinated release checklist](E2EE_FRESH_DEPLOY.md).
They specify fresh database creation, signed 2.0.0+ CLI and skill artifacts,
mandatory Worker secrets, bootstrap locking, enrollment and encrypted smoke tests.
The old artifact pin cannot build a deployable protocol-2 server.

Create a new database and preserve the existing one. Deployment or deletion of an
existing installation requires its owner's authorization. This branch does not deploy it.

For GitHub Actions deployment, configure Cloudflare authorization through repository
secrets; never commit credentials. Review `.github/workflows/deploy.yml` before
turning it on. A merge of source changes is not a coordinated release: the signed
artifact manifest PR must land first, and deployment must name the new database.

Required Worker secrets are `TOKEN_PEPPER` and `READ_RECEIPT_SECRET`, independently
generated. Keep them in the operator's secret store. The deploy workflow does not
generate or recover them.
