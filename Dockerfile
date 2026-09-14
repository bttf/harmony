FROM denoland/deno:2.4.5
WORKDIR /app
COPY . .
# Remote deps are fetched at build time ("lock": false upstream); cache them into the image.
RUN deno cache server/main.ts cli.ts
# Fresh ahead-of-time build (islands + static assets) into _fresh/.
RUN deno task build
ARG HARMONY_REVISION
# An empty DENO_DEPLOYMENT_ID would silently start the app in development mode.
RUN test -n "$HARMONY_REVISION"
ENV DENO_DEPLOYMENT_ID=${HARMONY_REVISION} \
    PORT=8000 \
    HARMONY_DATA_DIR=/data
RUN mkdir -p /data && chown -R deno:deno /app /deno-dir /data
USER deno
EXPOSE 8000
CMD ["deno", "run", "-A", "server/main.ts"]
