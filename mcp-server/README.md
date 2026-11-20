# MCP Server — 天气查询 MCP 服务

## 虚拟环境

> 需要 Python >= 3.10

```bash
# 创建（仅第一次，用 python3.12 指定版本）
python3.12 -m venv venv

# 激活
source venv/bin/activate

# 安装依赖
uv pip install -r requirements.txt
```

## 启动

```bash
cd mcp-server
source venv/bin/activate
python weather_server.py          # 直接测试 MCP 协议
```

## MCP 协议

| 方法 | 说明 |
|------|------|
| `tools/list` | 返回可用工具列表 |
| `tools/call` | 执行指定工具 |
