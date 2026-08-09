#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-nemanjan00/reverse-shell-listener}"
SHA="$(git rev-parse --short HEAD)"

echo "Building ${IMAGE}:latest and ${IMAGE}:${SHA} ..."
docker build -t "${IMAGE}:latest" -t "${IMAGE}:${SHA}" .

echo "Pushing ..."
docker push "${IMAGE}:latest"
docker push "${IMAGE}:${SHA}"

echo "Done."
echo "  ${IMAGE}:latest"
echo "  ${IMAGE}:${SHA}"
