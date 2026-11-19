# ============================================================
# baby-ai 前端镜像
#
# 构建上下文必须是**仓库根目录**（不是 client/）：
#   - client 属于根目录的 npm workspace，lock 文件在根目录；
#   - client/tsconfig.json extends ../tsconfig.base.json。
#
# 构建命令：
#   docker build -f client/Dockerfile -t baby-ai-client .
# ============================================================

FROM node:20-alpine AS build
WORKDIR /app

# workspace 根 + 两个子 workspace 的 package.json
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/

# 只装 client 需要的依赖；--include-workspace-root 保证根依赖也解析
RUN npm ci --workspace client --include-workspace-root

# TypeScript 配置继承自仓库根
COPY tsconfig.base.json ./
COPY client/ client/

RUN npm run build -w client


FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
