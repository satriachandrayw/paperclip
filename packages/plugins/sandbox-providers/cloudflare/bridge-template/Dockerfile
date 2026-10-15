ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.1
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM debian:bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    procps \
    tar \
    tini \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN git config --system --add safe.directory '*' \
  && printf 'export TAR_OPTIONS=--no-same-owner\n' > /etc/profile.d/paperclip-tar.sh \
  && mkdir -p /workspace

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
