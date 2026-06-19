# Local wrangler image — bakes wrangler in so CLI calls don't re-download it.
# This dir is the build context and contains ONLY this Dockerfile (clean context).
# Build once:  docker build -t wrangler-local backend/docker
# wrangler.sh builds/runs this image instead of `npx wrangler@latest`.
FROM node:22-slim

# Pin a version for reproducibility; bump when you want to update.
ARG WRANGLER_VERSION=4.101.0
RUN npm install -g wrangler@${WRANGLER_VERSION} \
    && npm cache clean --force

WORKDIR /worker
ENTRYPOINT ["wrangler"]
