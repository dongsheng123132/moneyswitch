# Build from the tested package produced by scripts/build-us-release.mjs.
# BASE_IMAGE retains the already installed Linux native addon; build refuses dependency drift.
ARG BASE_IMAGE=moneyswitch:919ccae
FROM ${BASE_IMAGE}
ARG REVISION
LABEL org.opencontainers.image.revision=$REVISION
COPY dist /app/dist
COPY dashboard /app/dashboard
COPY migrations /app/migrations
