FROM node:22-slim
WORKDIR /app
# Testnet only: the receiver refuses to start with any other RECEIVER_MODE.
ENV NODE_ENV=production RECEIVER_PORT=4021 RECEIVER_MODE=testnet
COPY receiver.cjs ./receiver.cjs
USER node
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4021/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "receiver.cjs"]
