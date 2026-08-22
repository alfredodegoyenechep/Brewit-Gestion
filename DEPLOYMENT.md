# Deploying Brewit (step-by-step)

This file shows quick steps to run locally with Docker and deploy to a small, low-cost cloud provider (Fly.io recommended for small Docker-backed apps).

1) Quick local test with Docker

```bash
# build image
docker build -t brewit:local .

# run with uploads persisted to local `uploads/`
docker run --rm -p 3000:3000 -e NODE_ENV=production -e PORT=3000 -v "$PWD/uploads":/usr/src/app/uploads brewit:local
```

Open http://localhost:3000 in your browser.

2) Deploy to Fly.io (recommended free/low-cost option)

- Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
- Create an account at https://fly.io/
- From the project root run:

```bash
flyctl launch --copy-config --name brewit-app --platform linux/amd64
# Accept defaults; when it asks about deploying now, say no (we'll build a Docker image locally or let flyctl build it).

# To deploy now:
flyctl deploy
```

Fly will build the Docker image and give you a public URL with TLS automatically.

3) Alternative: Render / DigitalOcean / Railway

- These providers allow connecting a GitHub repo and auto-deploying. The steps are similar: create account, new service, choose Docker or Node, set build command, and set `PORT=3000` environment variable.

4) Post-deploy checklist

- Configure environment variables (secrets) in the provider dashboard (e.g., `NODE_ENV`, `PORT`, any API keys).
- Set up backups for the `uploads/` directory (object storage like S3 or provider volumes).
- Add simple authentication before sharing externally (see next steps).

If you'd like, I can:
- Create a GitHub Actions workflow to build and push Docker images, or
- Prepare a Render or Fly.io specific deployment YAML and walk you through creating the account and running the commands.
