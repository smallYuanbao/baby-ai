FROM python:3.12-slim

WORKDIR /app

# curl 给健康检查用
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# 先装 CPU 版 torch，避免把 nvidia-* / CUDA 运行库打进镜像：
#   - 镜像从约 8–10GB 降到 2GB 左右
#   - 构建时间显著缩短
# 之后再装其余依赖时，pip 会认为 torch 已满足，不会重复下载。
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY server.py .

EXPOSE 8011

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://127.0.0.1:8011/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8011"]
