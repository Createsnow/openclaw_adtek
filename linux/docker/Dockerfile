# xA Gateway 镜像：官方 OpenClaw + OA 桥接插件（含依赖）。
# 在仓库 linux/ 目录下构建：
#   docker build -f docker/Dockerfile -t xa-gateway-oa:2026.9.2 .
# 现网配置 bridge-config.json 不进镜像，由 compose 只读挂载到 /opt/xa/oa-workflow-bridge/bridge-config.json。
# 本机已有别的官方镜像名（如 openclaw/openclaw:latest）时：--build-arg OPENCLAW_IMAGE=<那个名字>
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.2
FROM ${OPENCLAW_IMAGE}

USER root
# 国内拉 npm 慢时：--build-arg npm_config_registry=https://registry.npmmirror.com
ARG npm_config_registry
COPY OA_tool/oa-workflow-bridge /opt/xa/oa-workflow-bridge
RUN cd /opt/xa/oa-workflow-bridge \
 && rm -rf node_modules tests bridge-config.json \
 && npm ci --omit=dev --no-audit --no-fund \
 && mkdir -p /home/node/.cache \
 && chmod 1777 /home/node /home/node/.cache
# 容器按宿主机用户的 uid 运行（不一定是 1000）：
# - 插件目录保持 root 所有、只读。OpenClaw 只加载属于当前用户或 root 的插件，root 对任何 uid 都放行
# - HOME 与 ~/.cache 让任何 uid 都能写（OpenClaw 在 ~/.cache 下建临时目录）
USER 1000:1000
