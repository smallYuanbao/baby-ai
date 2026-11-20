# ========== 第一阶段：构建阶段 ==========
FROM python:3.12-slim AS builder

# 安装依赖到虚拟环境（入口脚本/CLI 工具都会正确保留）
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY requirements/base.txt requirements/
RUN pip install --no-cache-dir -r requirements/base.txt -i https://pypi.tuna.tsinghua.edu.cn/simple


# ========== 第二阶段：运行阶段 ==========
FROM python:3.12-slim AS runner

# 健康检查用
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 复制完整的虚拟环境（含所有 CLI 工具）
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 复制代码
WORKDIR /app
COPY app/ app/

# 安全加固 + 运行期目录
# 注意：不要把 .env 打进镜像（密钥会跟着镜像走）；运行时由 compose 注入。
# data/uploads/logs 由 compose 挂卷覆盖，这里先建好并交给 appuser，避免首次启动权限错误。
RUN useradd -m -u 1000 appuser \
    && mkdir -p /app/data /app/uploads /app/logs \
    && chown -R appuser:appuser /app
USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:8010/api/health || exit 1

EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
