FROM node:20-bookworm-slim AS node_runtime

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for Playwright Chromium runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Bring Node.js + npm from official node image
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Python dependencies
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Node dependencies for metrics bridge
COPY node_scripts/package.json /app/node_scripts/package.json
COPY node_scripts/package-lock.json /app/node_scripts/package-lock.json
RUN cd /app/node_scripts && npm ci --omit=dev

# Install Chromium for Node Playwright
RUN cd /app/node_scripts && npx playwright install --with-deps chromium

# App code
COPY bot /app/bot
COPY node_scripts /app/node_scripts
COPY EnvExample /app/EnvExample
COPY leads.example.json /app/leads.example.json
COPY barnaul_salons_all.json /app/barnaul_salons_all.json

CMD ["python", "-m", "bot"]
