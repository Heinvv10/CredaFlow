# Stage 1: Install dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=1
# The face comparison runs onnxruntime-node on the CPU only; skip the ~270MB
# of CUDA providers its postinstall otherwise downloads on linux/x64.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --legacy-peer-deps

# Stage 2: Build
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG NEXT_PUBLIC_TENANT_SLUG=
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ARG NEXT_PUBLIC_MATOMO_URL=
ARG NEXT_PUBLIC_MATOMO_SITE_ID=
ARG NEXT_PUBLIC_GTM_ID=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
# Base URL (incl. /portal/login) for cross-host client-portal links. An
# unset ARG still lands in the image as ENV-defined "" (not absent) below —
# lib/config/deployment-urls.ts and NavBar.tsx both coerce "" to undefined.
# There is no hardcoded fallback: with neither portal URL set, portal links
# are omitted or refused. Set per environment so links target its own portal.
ARG NEXT_PUBLIC_PORTAL_LOGIN_URL=
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV NEXT_PUBLIC_TENANT_SLUG=$NEXT_PUBLIC_TENANT_SLUG
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_PORTAL_LOGIN_URL=$NEXT_PUBLIC_PORTAL_LOGIN_URL
ENV NEXT_PUBLIC_MATOMO_URL=$NEXT_PUBLIC_MATOMO_URL
ENV NEXT_PUBLIC_MATOMO_SITE_ID=$NEXT_PUBLIC_MATOMO_SITE_ID
ENV NEXT_PUBLIC_GTM_ID=$NEXT_PUBLIC_GTM_ID
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# Face-comparison models (YuNet + SFace), downloaded at a pinned opencv_zoo
# commit and refused unless their SHA-256s match. Before the build: next.config
# traces face-models/ into the standalone output the runner copies.
RUN npm run face-models:fetch
RUN NODE_OPTIONS=--max-old-space-size=6144 npm run build

# Stage 3: Migration runner (`docker build --target migrator`). Only the Prisma
# CLI and the migrations: the runner image below ships neither, and the Helm
# chart's pre-upgrade Job (deploy/helm/credaflow) runs `prisma migrate deploy`
# from this image. It must stay ABOVE the runner stage: a build with no
# --target (docker-compose) builds the last stage.
FROM node:22-bookworm-slim AS migrator
WORKDIR /app
# upgrade: pick up Debian security fixes newer than the base image (the image scan
# in .github/workflows/security.yml fails on fixable HIGH/CRITICAL). npm is removed:
# nothing here runs it, and its bundled packages are scanned as ours.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY package.json ./
COPY prisma ./prisma
# The root filesystem is read-only in the cluster: Prisma's cache and update check
# write under $HOME, so point it at the Job's /tmp emptyDir and switch the check off.
ENV HOME=/tmp
ENV CHECKPOINT_DISABLE=1
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# Stage 4: Production runner
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
# upgrade and npm removal: see the migrator stage.
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends openssl ca-certificates poppler-utils qpdf chromium fonts-liberation && \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
ENV PORT=3300
ENV HOSTNAME=0.0.0.0
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1

# --create-home: chromium (lib/documents/html-to-pdf.ts) writes to $HOME and
# fails to launch when /home/nextjs does not exist.
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --create-home --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# lib/storage.ts writes to /app/uploads. A fresh named volume copies this
# directory's ownership; without it the volume is root-owned and every upload
# fails with EACCES.
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

USER nextjs

EXPOSE 3300

CMD ["node", "server.js"]
